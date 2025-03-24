const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const db = require('../db');
const validateRequest = require('../middleware/validate-request');
const handler = require('../middleware/handler');
const userService = require('../service/user');

router.post('/vote', [
    body('video_id').isString(),
    body('user_id').isString(),
    body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('category_id').isInt({ min: 1 }),
    body('start').isInt({ min: 0 }),
    body('end').isInt({ min: 0 }),
    body('vote').isInt({ min: -1, max: 1 }),
    validateRequest
],
handler(async (req, res) => {
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

    const prevVote = await db.Vote.findOne({
        where: {
            user_id: userId,
            video_id: video.id,
            category_id: categoryId,
            start: start,
            end: end
        }
    });

    voteObj = await db.Vote.create({
        user_id: userId,
        prv_user_id: req.body.prv_user_id,
        video_id: video.id,
        category_id: categoryId,
        start: start,
        end: end,
        vote: vote
    });

    await userService.updateRatingByVote(voteObj, prevVote);

    if (prevVote) {
        await prevVote.destroy();
    }

    res.status(204).send();
}))

/**
 * TODO: Method GET because of Grafana
 */
router.get('/votes/:id/delete', handler(async (req, res) => {
    const voteId = req.params.id;

    if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
        res.status(401).send('Unauthorized');
        return;
    }

    let vote = await db.Vote.findByPk(voteId);
    if (!vote) {
        res.status(404).send('Vote not found');
        return;
    }

    await db.db.transaction(async (transaction) => {
        await db.Vote.destroy({
            where: { id: voteId },
            transaction
        });

        let user = await db.User.findOne({
            where: {
                generated_user_id: vote.user_id,
                prv_user_id: vote.prv_user_id
            }
        });
        if (!user) {
            res.status(404).send('User not found');
            return;
        }
    
        await user.decrement('rating', { by: vote.vote }, transaction);
    });

    res.status(201).send('Updated');
}))

/**
 * TODO: Method GET because of Grafana
 */
router.get('/votes/user/:internal_user_id/update-rating', handler(async (req, res) => {
    const internalUserId = req.params.internal_user_id;

    if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
        res.status(401).send('Unauthorized');
        return;
    }

    let user = await db.User.findByPk(internalUserId);
    if (!user) {
        res.status(404).send('Not found');
        return;
    }

    await user.update({
        rating: req.query.rating
    });

    res.status(201).send('Updated');
}))

module.exports = router;
