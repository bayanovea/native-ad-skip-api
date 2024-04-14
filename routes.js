const express = require('express');
const router = express.Router();
const db = require('./db');
const middleware = require('./middleware');
const prometheusWrapper = require('./prometheus-wrapper');

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
router.get('/video-calculated', async (req, res) => {
    try {
        if (!req.query.video_id || typeof req.query.video_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }

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
router.post('/markup', async (req, res) => {
    try {
        const blockedUserIds = ['689613b1-e95c-410a-8879-6745c72a0a9a'];
        let videoId = req.body.video_id;

        if (!videoId || typeof videoId !== 'string') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.user_id || typeof req.body.user_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }
        if (req.body.vk_user_id && (typeof req.body.vk_user_id !== 'number' || req.body.vk_user_id < 0)) {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.data || typeof req.body.data !== 'object') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.data.intervals) {
            res.status(400).send('Bad request');
            return;
        }

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
            vk_user_id: req.body.vk_user_id,
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
        const verifyBearerToken = req.query.verifyBearerToken;

        if (verifyBearerToken !== process.env.VERIFY_BEARER_TOKEN) {
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

router.post('/vote', async (req, res) => {
    try {
        const videoId = req.body.video_id;
        const userId = req.body.user_id;
        const vkUserId = req.body.vk_user_id;
        const categoryId = req.body.category_id;
        const start = req.body.start;
        const end = req.body.end;
        const vote = req.body.vote;
    
        if (!videoId || typeof videoId !== 'string') {
            res.status(400).send('Bad request: video_id');
            return;
        }

        if (!userId || typeof userId !== 'string') {
            res.status(400).send('Bad request: user_id');
            return;
        }

        if (vkUserId && (typeof vkUserId !== 'number' || vkUserId < 0)) {
            res.status(400).send('Bad request: vk_user_id');
            return;
        }

        if (!categoryId || typeof categoryId !== 'number') {
            res.status(400).send('Bad request: category_id');
            return;
        }

        if (typeof start !== 'number' || start < 0) {
            res.status(400).send('Bad request: start');
            return;
        }

        if (typeof end !== 'number' || end < 0) {
            res.status(400).send('Bad request: end');
            return;
        }

        if (typeof vote !== 'number' || vote < -1 || vote > 1) {
            res.status(400).send('Bad request: vote');
            return;
        }

        const video = await db.Video.findOne({
            where: { native_id: videoId }
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
            vk_user_id: vkUserId,
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
        const verifyBearerToken = req.query.verifyBearerToken;

        if (verifyBearerToken !== process.env.VERIFY_BEARER_TOKEN) {
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
