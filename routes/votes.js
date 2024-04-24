const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const db = require('../db');
const validateRequest = require('../middleware/validate-request');

router.post('/vote', [
    body('video_id').notEmpty().isString(),
    body('user_id').notEmpty().isString(),
    body('vk_user_id').optional().isInt({ min: 1 }),
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
            vk_user_id: req.body.vk_user_id,
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

module.exports = router;
