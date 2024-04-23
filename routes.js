const express = require('express');
const router = express.Router();
const db = require('./db');
const middleware = require('./middleware');
const prometheusWrapper = require('./prometheus-wrapper');
const { body } = require('express-validator');
const validateRequest = require('./middleware/validate-request');

/**
 * Check
 */
router.get('/', (req, res, next) => {
    res.send({
        status: 'ok'
    })
})

/**
 * Get calculated data by video 
 */
router.get('/video-calculated',
    [
        body('video_id').notEmpty().isString(),
        validateRequest
    ],
async (req, res) => {
    try {
        let nativeFullVideoId = req.query.video_id;
        let video;
        
        if (req.query.v) {
            video = await db.Video.findOne({
                where: { native_id: nativeFullVideoId }
            });
        } else { // Crutch for old versions when frontend always send video id without minus
            prometheusWrapper.incrementRequestWithoutVersion('GET /video-calculated', nativeFullVideoId);

            let nativeFullVideoIdMinus = '-' + nativeFullVideoId;

            video = await db.Video.findOne({
                where: { native_id: nativeFullVideoIdMinus }
            });

            if (!video) {
                video = await db.Video.findOne({
                    where: { native_id : nativeFullVideoId }
                });
            }
        }

        if (!video) {
            prometheusWrapper.incrementVideoCalculatedNotFound(nativeFullVideoId);
            res.status(204).send();
            return;
        }

        const videoCalculated = await db.VideoCalculated.findOne({
            where: { video_id: String(video.id) }
        });

        if (!videoCalculated) {
            prometheusWrapper.incrementVideoCalculatedNotFound(nativeFullVideoId);
            res.status(204).send();
            return;
        }

        prometheusWrapper.incrementVideoCalculatedFound(nativeFullVideoId);
        res.status(200).send(videoCalculated.data);
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Create markup
 */
router.post('/markup', [
        body('video_id').notEmpty().isString(),
        body('user_id').notEmpty().isString(),
        body('prv_user_id').optional().isInt({ min: 1 }),
        body('category_id').notEmpty().isInt({ min: 1 }),
        body('data').custom((value) => {
            if (typeof value !== 'object') {
                throw new Error('data must be an object');
            }
            return true;
        }),
        body('data.intervals').custom((value) => {
            if (!Array.isArray(value)) {
                throw new Error('data.intervals must be an array');
            }
            return true;
        }),
        validateRequest
    ],
async (req, res) => {
    try {
        const blockedUserIds = ['689613b1-e95c-410a-8879-6745c72a0a9a'];
        let videoId = req.body.video_id;

        if (blockedUserIds.includes(req.body.user_id)) {
            res.status(201).send('Created'); // fake response
            return;
        }

        // Crutch for old versions when frontend always send video id without minus
        if (!req.body.v) {
            prometheusWrapper.incrementRequestWithoutVersion('POST /markup', videoId);
            videoId = '-' + videoId;
        }

        const [video, created] = await db.Video.findOrCreate({
            where: { native_id: videoId }
        });

        const markup = await db.Markup.create({
            video_id: video.id,
            user_id: req.body.user_id,
            prv_user_id: req.body.prv_user_id,
            category_id: req.body.category_id
        });

        for (const interval of req.body.data.intervals) {
            const markupInterval = await db.MarkupTimeInterval.create({
                markup_id: markup.id,
                // Currently we support only integer values
                start: Math.round(interval.start),
                end: Math.round(interval.end)
            });
        }

        res.status(201).send('Created');
    } catch (error) {
        console.error('Failed to create a new markup: ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Edit markup
 */
router.put('/markups', [
        body('video_id').notEmpty().isString(),
        body('user_id').notEmpty().isString(),
        body('prv_user_id').optional().isInt({ min: 1 }),
        body('category_id').notEmpty().isInt({ min: 1 }),
        body('start').notEmpty().isInt({ min: 0 }),
        body('end').notEmpty().isInt({ min: 0 }),
        body('new_start').notEmpty().isInt({ min: 0 }),
        body('new_end').notEmpty().isInt({ min: 0 }),
        validateRequest
    ],
async (req, res) => {
    try {
        let video = await db.Video.findOne({
            where: { native_id: req.body.video_id }
        });

        if (!video) {
            res.status(404).send('Not found');
            return;
        }

        let markups = await db.Markup.findAll({
            where: { 
                video_id: video.id,
                user_id: req.body.user_id,
                category_id: req.body.category_id,
            }
        });

        if (markups.length === 0) {
            res.status(404).send('Not found');
            return;
        }

        let markupIds = markups.map(markup => markup.id);

        let markupInterval = await db.MarkupTimeInterval.findOne({
            where: {
                markup_id: markupIds,
                start: req.body.start,
                end: req.body.end
            }
        });

        if (!markupInterval) {
            res.status(404).send('Not found');
            return;
        }

        await db.db.transaction(async (transaction) => {
            await db.MarkupTimeInterval.update({
                start: req.body.new_start,
                end: req.body.new_end,
                is_new: true
            }, {
                where: {
                    id: markupInterval.id
                }
            });
    
            await db.Markup.update({
                is_new: true
            }, {
                where: {
                    id: markupInterval.markup_id
                }
            });
        });

        res.status(200).send('Updated');
    } catch (error) {
        console.error('Failed to update markup: ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Get markups by filter
 */
router.get('/markups', middleware.verifyBearerToken, async (req, res) => {
    try {
        let markups = await db.MarkupRepository.findByRequest(req);
        res.status(200).send(markups);
    } catch (error) {
        console.error('Failed to get markups: ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Delete markup
 */
router.delete('/markups/:id', middleware.verifyBearerToken, async (req, res) => {
    try {
        const markupId = req.params.id;

        let markup = await db.Markup.findByPk(markupId)
        if (!markup) {
            res.status(404).send('Not found ' . markupId );
            return;
        }

        await db.db.transaction(async (transaction) => {
            await db.MarkupTimeInterval.destroy({
                where: { markup_id: markupId },
                transaction
            });

            await db.Markup.destroy({
                where: { id: markupId },
                transaction
            });

            let videoMarkups = await db.Markup.findAll({
                where: { video_id: markup.video_id },
                transaction
            });

            if (videoMarkups.length > 0) {
                // Update rest markups as new for recalculating without deleted markup
                await db.Markup.update(
                    { is_new: true },
                    { 
                        where: { video_id: markup.video_id },
                        transaction
                    },
                );
            } else {
                // Don't need to recalculate video because there are no markups, so delete calculated data
                await db.VideoCalculated.destroy({
                    where: { video_id: markup.video_id },
                    transaction
                });
            }
        });

        res.status(201).send('Deleted');
    } catch (error) {
        console.error('Failed to delete markup: ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Delete markup via GET (DUPLICATE)
 * 
 * TODO: NEED THIS DUPLICATE BECAUSE OF GRAFANA, AFTER FIXING GRAFANA NEED TO DELETE THIS
 */
router.get('/markups/:id/delete', async (req, res) => {
    try {
        const markupId = req.params.id;

        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        let markup = await db.Markup.findByPk(markupId)
        if (!markup) {
            res.status(404).send('Not found ' . markupId );
            return;
        }

        await db.db.transaction(async (transaction) => {
            await db.MarkupTimeInterval.destroy({
                where: { markup_id: markupId },
                transaction
            });

            await db.Markup.destroy({
                where: { id: markupId },
                transaction
            });

            let videoMarkups = await db.Markup.findAll({
                where: { video_id: markup.video_id },
                transaction
            });

            if (videoMarkups.length > 0) {
                // Update rest markups as new for recalculating without deleted markup
                await db.Markup.update(
                    { is_new: true },
                    { 
                        where: { video_id: markup.video_id },
                        transaction
                    },
                );
            } else {
                // Don't need to recalculate video because there are no markups, so delete calculated data
                await db.VideoCalculated.destroy({
                    where: { video_id: markup.video_id },
                    transaction
                });
            }
        });

        res.status(201).send('Deleted');
    } catch (error) {
        console.error('Failed to delete markup: ', error);
        res.status(500).send('Internal Server Error');
    }
});

router.delete('/videos/:id/markups', middleware.verifyBearerToken, async (req, res) => {
    try {
        let videoId = req.params.id;

        // Check if passed video native id
        if (isNaN(videoId)) {
            let video = await db.Video.findOne({
                where: { native_id: videoId }
            });

            if (!video) {
                res.status(404).send('Not found');
                return;
            }

            videoId = video.id;
        }
        
        // Collect all markups, intervals ids for common delete query
        let videoMarkups = await db.Markup.findAll({
            where: { video_id: String(videoId) }
        });
        markupIds = videoMarkups.map(markup => markup.id);

        let markupIntervals = await db.MarkupTimeInterval.findAll({
            where: { markup_id: markupIds }
        });
        markupIntervalIds = markupIntervals.map(interval => interval.id);

        // Delete all markups, intervals, calculated data
        await db.db.transaction(async (transaction) => {
            await db.MarkupTimeInterval.destroy({
                where: { id: markupIntervalIds },
                transaction
            });

            await db.Markup.destroy({
                where: { id: markupIds },
                transaction
            });

            await db.VideoCalculated.destroy({
                where: { video_id: videoId },
                transaction
            });
        });

        res.status(201).send('Deleted');
    } catch (error) {
        console.error('Failed to delete video\'s markups: ', error);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/vote', [
        body('video_id').notEmpty().isString(),
        body('user_id').notEmpty().isString(),
        body('prv_user_id').optional().isInt({ min: 1 }),
        body('category_id').notEmpty().isInt({ min: 1 }),
        body('start').notEmpty().isInt({ min: 0 }),
        body('end').notEmpty().isInt({ min: 0 }),
        body('vote').notEmpty().isInt({ min: -1, max: 1 }),
        validateRequest
    ],
async (req, res) => {
    try {
        const userId = req.body.user_id;
        const categoryId = req.body.category_id;
        const start = req.body.start;
        const end = req.body.end;
        const vote = req.body.vote;

        const video = await db.Video.findOne({
            where: { native_id: req.body.video_id }
        });
        if (!video) {
            res.status(404).send('Not found');
            return;
        }

        const calculatedVideo = await db.VideoCalculated.findOne({
            where: { video_id: video.id }
        });
        if (!calculatedVideo) {
            res.status(404).send('Not found');
            return;
        }

        let segment;
        calculatedVideo.data.forEach(item => {
            if (item.category_id === categoryId && item.start === start && item.end === end) {
                segment = item;
                return;
            }
        });

        if (!segment) {
            res.status(404).send('Not found');
            return;
        }

        await db.Vote.destroy({
            where: {
                user_id: userId,
                video_id: video.id,
                category_id: categoryId,
                start: start,
                end: end
            }
        });

        if (vote === 0) {
            res.status(204).send();
            return;
        }

        await db.Vote.create({
            user_id: userId,
            prv_user_id: req.body.prv_user_id,
            video_id: video.id,
            category_id: categoryId,
            start: start,
            end: end,
            vote: vote
        });

        res.status(204).send();
    } catch (error) {
        console.error('Failed to vote: ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * TODO: Method GET because of Grafana
 */
router.get('/votes/:id/delete', async (req, res) => {
    try {
        const voteId = req.params.id;

        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        let vote = await db.Vote.destroy({
            where: { id: voteId }
        });

        if (!vote) {
            res.status(404).send('Not found');
            return;
        }

        res.status(201).send('Deleted');
    } catch (error) {
        console.error('Failed to delete vote: ', error);
        res.status(500).send('Internal Server Error');
    }
});


/**
 * Prometheus internal endpoint   
 */
router.get('/metrics', (req, res, next) => {
    res.set('Content-Type', metricsMiddleware.promClient.register.contentType);
    res.end(metricsMiddleware.promClient.register.metrics());
})

/**
 * Check logs
 */
router.get('/gdfgestshgergevcv3rwrf2e2e', (req, res, next) => {
    console.error('qqq1');
    console.log('qqq2');
    throw new Error('qqq3');
})

module.exports = router;
