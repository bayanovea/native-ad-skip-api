const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const db = require('../db');
const prometheusWrapper = require('../prometheus-wrapper');
const validateRequest = require('../middleware/validate-request');

/**
 * Get calculated data by video 
 */
router.get('/video-calculated',
    [
        query('video_id').notEmpty().isString(),
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

module.exports = router;
