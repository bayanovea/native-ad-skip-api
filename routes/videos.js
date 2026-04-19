const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const db = require('../db');
const prometheusWrapper = require('../prometheus-wrapper');
const validateRequest = require('../middleware/validate-request');
const handler = require('../middleware/handler');
const durationLogRepository = require('../repository/duration-log');

/**
 * Get calculated data by video 
 */
router.get('/video-calculated',
    [
        query('video_id').isString(),
        query('duration').optional().isInt().toInt(),
        query('user_id').optional().isString(),
        query('prv_user_id').optional().isInt({ min: 1 }).toInt(),
        validateRequest
    ],
handler(async (req, res) => {
    const duration = req.query.duration;
    let nativeFullVideoId = req.query.video_id;
    let video;
    
    if (req.query.v) {
        video = await db.Video.findOne({
            where: { native_id: nativeFullVideoId }
        });

        if (req.query.user_id && video && duration && video.duration != duration && video.status != 1) {
            const [user] = await db.User.findOrCreate({
                where: {
                    generated_user_id: req.query.user_id,
                    prv_user_id: req.query.prv_user_id ?? null,
                }
            });
            await durationLogRepository.createOrIncrement(user.id, video.id, duration);
        }
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
}))

module.exports = router;
