const express = require('express');
const router = express.Router();
const db = require('./db');
const middleware = require('./middleware');

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

        const video = await db.Video.findOne({
            where: { native_id: req.query.video_id }
        });

        if (!video) {
            res.status(404).send('Not found');
            return;
        }

        const videoCalculated = await db.VideoCalculated.findOne({
            where: { video_id: String(video.id) }
        });

        if (!videoCalculated) {
            res.status(204).send();
            return;
        }

        console.log(videoCalculated.data);
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
        if (!req.body.video_id || typeof req.body.video_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.user_id || typeof req.body.user_id !== 'string') {
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

        const [video, created] = await db.Video.findOrCreate({
            where: { native_id: req.body.video_id }
        });

        const markup = await db.Markup.create({
            video_id: video.id,
            user_id: req.body.user_id,
            category_id: req.body.category_id
        });

        for (const interval of req.body.data.intervals) {
            const markupInterval = await db.MarkupTimeInterval.create({
                markup_id: markup.id,
                start: interval.start,
                end: interval.end
            });

            console.log(markupInterval);
        }

        res.status(201).send('Created');

    } catch (error) {
        console.error('Failed to create a new record : ', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * Get markups by filter
 */
router.get('/markups', middleware.verifyBearerToken, async (req, res) => {
    try {
        let markups = await db.MarkupRepository.findByRequest(req);
        console.log(markups)
        res.status(200).send(markups);
    } catch (error) {
        console.error('Failed to get markups : ', error);
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
        console.error('Failed to delete markup : ', error);
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
        console.error('Failed to delete video\'s markups : ', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
