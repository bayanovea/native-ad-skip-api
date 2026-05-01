const express = require('express');
const { body } = require('express-validator');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

module.exports = function createVoteRoutes(models, { videoRepository, userService }) {
    const router = express.Router();
    const sequelize = models.Vote.sequelize;

    router.post('/vote', [
        body('video_id').isString(),
        body('user_id').isString(),
        body('prv_user_id').isInt({ min: 1 }),
        body('category_id').isInt({ min: 1 }),
        body('start').isInt({ min: 0 }),
        body('end').isInt({ min: 0 }),
        body('vote').isInt({ min: -1, max: 1 }),
        body('duration').isInt({ min: 1 }),
        validateRequest,
    ],
    handler(async (req, res) => {
        const { user_id: userId, category_id: categoryId, start, end, vote, duration } = req.body;

        const video = await videoRepository.findByNativeIdAndDuration(req.body.video_id, duration);
        if (!video) { res.status(404).send('Not found'); return; }

        const calculatedVideo = await models.VideoCalculated.findOne({ where: { video_id: video.id } });
        if (!calculatedVideo) { res.status(404).send('Not found'); return; }

        let segment;
        calculatedVideo.data.forEach(item => {
            if (item.category_id === categoryId && item.start === start && item.end === end) {
                segment = item;
            }
        });
        if (!segment) { res.status(404).send('Not found'); return; }

        const prevVote = await models.Vote.findOne({
            where: { user_id: userId, video_id: video.id, category_id: categoryId, start, end },
        });

        const voteObj = await models.Vote.create({
            user_id: userId,
            prv_user_id: req.body.prv_user_id,
            video_id: video.id,
            category_id: categoryId,
            start,
            end,
            vote,
        });

        await userService.updateRatingByVote(voteObj, prevVote);

        if (prevVote) await prevVote.destroy();

        res.status(204).send();
    }));

    // GET duplicate for Grafana compatibility
    router.get('/votes/:id/delete', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const vote = await models.Vote.findByPk(req.params.id);
        if (!vote) { res.status(404).send('Vote not found'); return; }

        await sequelize.transaction(async (transaction) => {
            await models.Vote.destroy({ where: { id: req.params.id }, transaction });

            const user = await models.User.findOne({
                where: { generated_user_id: vote.user_id, prv_user_id: vote.prv_user_id },
            });
            if (!user) { res.status(404).send('User not found'); return; }

            await user.decrement('rating', { by: vote.vote }, transaction);
        });

        res.status(201).send('Updated');
    }));

    router.get('/votes/user/:internal_user_id/update-rating', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const user = await models.User.findByPk(req.params.internal_user_id);
        if (!user) { res.status(404).send('Not found'); return; }

        await user.update({ rating: req.query.rating });

        res.status(201).send('Updated');
    }));

    return router;
};
