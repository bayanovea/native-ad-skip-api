const express = require('express');
const { query } = require('express-validator');
const prometheusWrapper = require('../../prometheus-wrapper');
const { findVideoForReadWithOutcome } = require('../../lib/find-video-for-read');
const { findAiCalculated, AI_LOOKUP_OUTCOMES } = require('../../lib/find-ai-calculated');
const { parseViewsText } = require('../../lib/parse-views-text');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

// The extension sends the counter cut to 64 characters; longer is someone else's, kept only this far.
const VIEWS_TEXT_MAX = 128;

module.exports = function createVideoRoutes(models, { videoRepository, durationLogRepository, aiRepository }) {
    const router = express.Router();

    router.get('/video-calculated', [
        query('video_id').isString(),
        query('duration').optional().isInt().toInt(),
        query('user_id').optional().isString(),
        query('prv_user_id').optional().isInt({ min: 1 }).toInt(),
        validateRequest,
    ],
    handler(async (req, res) => {
        const duration = req.query.duration;
        const nativeFullVideoId = req.query.video_id;

        if (!req.query.v) {
            prometheusWrapper.incrementRequestWithoutVersion('GET /video-calculated', 'prv');

            let video = await models.Video.findOne({ where: { native_id: '-' + nativeFullVideoId } });
            if (!video) {
                video = await models.Video.findOne({ where: { native_id: nativeFullVideoId } });
            }
            if (!video) { res.status(204).send(); return; }

            const videoCalculated = await models.VideoCalculated.findOne({ where: { video_id: String(video.id) } });
            if (!videoCalculated) { res.status(204).send(); return; }

            res.status(200).send(videoCalculated.data);
            return;
        }

        // The page's view counter as text; never a 400, an unreadable one only keeps the raw string for a look.
        const viewsText = typeof req.query.views_text === 'string' ? req.query.views_text.slice(0, VIEWS_TEXT_MAX) : null;
        res.once('finish', () => {
            aiRepository.seen(nativeFullVideoId, { views: parseViewsText(viewsText), viewsText })
                .catch(err => console.error('ai: seen failed:', nativeFullVideoId, err.message));
        });

        let { video, outcome } = await findVideoForReadWithOutcome(models, nativeFullVideoId, duration);

        // if (video && duration) {
        //     const durationDiff = video.duration === null ? null : Math.abs(video.duration - duration);
        //     if (req.query.user_id && video.status != 1 && (durationDiff === null || durationDiff > 1)) {
        //         const [user] = await models.User.findOrCreate({
        //             where: { generated_user_id: req.query.user_id, prv_user_id: req.query.prv_user_id ?? null },
        //         });
        //         await durationLogRepository.createOrIncrement(user.id, video.id, duration);
        //     }
        // }

        if (!video) {
            prometheusWrapper.incrementVideoCalculatedLookup(outcome, 'prv');
            res.status(204).send();
            return;
        }

        const aiCalculated = AI_LOOKUP_OUTCOMES.has(outcome) ? await findAiCalculated(models, video.id) : null;
        if (aiCalculated) {
            prometheusWrapper.incrementVideoCalculatedLookup(outcome, 'prv', 'ai');
            res.status(200).send(aiCalculated.data);
            return;
        }

        const videoCalculated = await models.VideoCalculated.findOne({ where: { video_id: String(video.id) } });
        if (!videoCalculated) {
            prometheusWrapper.incrementVideoCalculatedLookup('not_calculated', 'prv');
            res.status(204).send();
            return;
        }

        prometheusWrapper.incrementVideoCalculatedLookup(outcome, 'prv');
        res.status(200).send(videoCalculated.data);
    }));

    return router;
};
