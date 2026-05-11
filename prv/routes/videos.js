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
        let video;

        if (req.query.v) {
            video = await findVideoForRead(models, nativeFullVideoId, duration);

            // if (video && duration) {
            //     const durationDiff = video.duration === null ? null : Math.abs(video.duration - duration);
            //     if (req.query.user_id && video.status != 1 && (durationDiff === null || durationDiff > 1)) {
            //         const [user] = await models.User.findOrCreate({
            //             where: { generated_user_id: req.query.user_id, prv_user_id: req.query.prv_user_id ?? null },
            //         });
            //         await durationLogRepository.createOrIncrement(user.id, video.id, duration);
            //     }
            // }
        } else {
            prometheusWrapper.incrementRequestWithoutVersion('GET /video-calculated', nativeFullVideoId);

            video = await models.Video.findOne({ where: { native_id: '-' + nativeFullVideoId } });
            if (!video) {
                video = await models.Video.findOne({ where: { native_id: nativeFullVideoId } });
            }
        }

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

        console.log(`[video-calculated] id=${videoCalculated.id} video_id=${video.id} native_id=${nativeFullVideoId}`);
        prometheusWrapper.incrementVideoCalculatedFound(nativeFullVideoId);
        res.status(200).send(videoCalculated.data);
    }));

    return router;
};
