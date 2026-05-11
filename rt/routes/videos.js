const express = require('express');
const { Op } = require('sequelize');
const { query } = require('express-validator');
const prometheusWrapper = require('../../prometheus-wrapper');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

async function findVideoForRead(models, nativeId, duration) {
    if (duration != null) {
        let video = await models.Video.findOne({
            where: { native_id: nativeId, duration: { [Op.between]: [duration - 1, duration + 1] } },
        });
        if (video) return video;

        video = await models.Video.findOne({ where: { native_id: nativeId, duration: null } });
        if (video) { await video.update({ duration }); return video; }

        return models.Video.findOne({ where: { native_id: nativeId } });
    }
    return models.Video.findOne({ where: { native_id: nativeId } });
}

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

        const video = await findVideoForRead(models, nativeFullVideoId, duration);

        if (!video) {
            prometheusWrapper.incrementVideoCalculatedNotFound(nativeFullVideoId);
            res.status(204).send();
            return;
        }

        const videoCalculated = await models.VideoCalculated.findOne({ where: { video_id: String(video.id) } });

        if (!videoCalculated) {
            prometheusWrapper.incrementVideoCalculatedNotFound(nativeFullVideoId);
            res.status(204).send();
            return;
        }

        prometheusWrapper.incrementVideoCalculatedFound(nativeFullVideoId);
        res.status(200).send(videoCalculated.data);
    }));

    return router;
};
