const express = require('express');
const { query } = require('express-validator');
const prometheusWrapper = require('../../prometheus-wrapper');
const { findVideoForReadWithOutcome } = require('../../lib/find-video-for-read');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

module.exports = function createVideoRoutes(models, { videoRepository, durationLogRepository }) {
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
