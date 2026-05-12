const express = require('express');
const { query } = require('express-validator');
const prometheusWrapper = require('../../prometheus-wrapper');
const { findVideoForReadWithOutcome } = require('../../lib/find-video-for-read');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

module.exports = function createVideoRoutes(models) {
    const router = express.Router();

    router.get('/video-calculated', [
        query('video_id').isString(),
        query('duration').isInt().toInt(),
        query('user_id').optional().isString(),
        query('prv_user_id').optional().isInt({ min: 1 }).toInt(),
        validateRequest,
    ],
    handler(async (req, res) => {
        const duration = req.query.duration;
        const nativeFullVideoId = req.query.video_id;

        const { video, outcome } = await findVideoForReadWithOutcome(models, nativeFullVideoId, duration);

        if (!video) {
            prometheusWrapper.incrementVideoCalculatedLookup(outcome, 'yt');
            res.status(204).send();
            return;
        }

        const videoCalculated = await models.VideoCalculated.findOne({ where: { video_id: String(video.id) } });
        if (!videoCalculated) {
            prometheusWrapper.incrementVideoCalculatedLookup('not_calculated', 'yt');
            res.status(204).send();
            return;
        }

        prometheusWrapper.incrementVideoCalculatedLookup(outcome, 'yt');
        res.status(200).send(videoCalculated.data);
    }));

    return router;
};
