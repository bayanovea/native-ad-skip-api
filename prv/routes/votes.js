const express = require('express');
const { body, query } = require('express-validator');
const validateRequest = require('../../middleware/validate-request');
const verifyQueryToken = require('../../middleware/verify-query-token');
const handler = require('../../middleware/handler');
const { lockVideoCalculated, recomputeSegmentRating, recomputeAiSegmentRating } = require('../../lib/segment-rating');
const { lockAiCalculated, servesAi } = require('../../lib/find-ai-calculated');

module.exports = function createVoteRoutes(models, { videoRepository, userService }) {
    const router = express.Router();
    const sequelize = models.Vote.sequelize;

    router.post('/vote', [
        body('video_id').isString(),
        body('user_id').isString(),
        body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
        body('category_id').isInt({ min: 1 }),
        body('start').isInt({ min: 0 }),
        body('end').isInt({ min: 0 }),
        body('vote').isInt({ min: -1, max: 1 }),
        body('duration').optional({ nullable: true }).isInt({ min: 1 }),
        validateRequest,
    ],
    handler(async (req, res) => {
        const { user_id: userId, category_id: categoryId, start, end, vote, duration } = req.body;

        const video = await videoRepository.findByNativeIdAndDuration(req.body.video_id, duration);
        if (!video) { res.status(404).send('Not found'); return; }

        // The segment comes from what GET /video-calculated serves: the AI row
        // when it is active and the vote carries a duration (the write lookup
        // then lands within ±2 s, as a served `match` / `backfilled` does), else
        // VideoCalculated. A vote belongs to the interval whatever source served
        // it, so every rating of these bounds is recomputed and the authors of
        // the interval are rated as on the human path. The row locks serialise
        // votes on the video with each other, with a recalculation
        // (`calculate`, `--recompute-ratings`), with a withdraw / review change
        // of the AI row and with its publish, which reads the votes holding
        // VideoCalculated: hence VideoCalculated first, then the AI row.
        const found = await sequelize.transaction(async (transaction) => {
            const calculatedVideo = await lockVideoCalculated(models, video.id, { transaction });
            const aiRow = await lockAiCalculated(models, video.id, { transaction });
            const served = duration != null && servesAi(aiRow) ? aiRow : calculatedVideo;
            if (!served) return false;

            const segment = (served.data || []).find(item =>
                item.category_id === categoryId && item.start === start && item.end === end);
            if (!segment) return false;

            // The latest row, as the rating rule reads it: pre-2026-10-17 data has several rows
            // per user and segment.
            const userVotes = { user_id: userId, video_id: video.id, category_id: categoryId, start, end };
            const prevVote = await models.Vote.findOne({
                where: userVotes,
                order: [['createdAt', 'DESC'], ['id', 'DESC']],
                transaction,
            });
            // The same vote again keeps its row, so its time stays when the user said it (the AI
            // judge reads a repeat as no new evidence) and no author rating moves; the segment
            // ratings are still recomputed, so a repeat repairs a drifted one.
            const repeat = prevVote && prevVote.vote === Number(vote);
            let voteObj;
            if (!repeat) {
                await models.Vote.destroy({ where: userVotes, transaction });
                voteObj = await models.Vote.create({
                    user_id: userId,
                    prv_user_id: req.body.prv_user_id,
                    video_id: video.id,
                    category_id: categoryId,
                    start,
                    end,
                    vote,
                }, { transaction });
            }

            if (aiRow) await recomputeAiSegmentRating(models, aiRow, { categoryId, start, end }, { transaction });
            if (calculatedVideo) await recomputeSegmentRating(models, { videoId: video.id, categoryId, start, end }, { transaction });

            if (!repeat) await userService.updateRatingByVote(voteObj, prevVote, { transaction });
            return true;
        });
        if (!found) { res.status(404).send('Not found'); return; }

        res.status(204).send();
    }));

    // GET duplicate for Grafana compatibility
    router.get('/votes/:id/delete', verifyQueryToken, handler(async (req, res) => {
        const vote = await models.Vote.findByPk(req.params.id);
        if (!vote) { res.status(404).send('Vote not found'); return; }

        // Undo what POST /vote did: the segment rating is recomputed without the
        // vote, and the authors' rating change is reversed (the voter's own
        // rating was never touched, so it is left alone). Every rating of the
        // interval is recomputed, as on POST, in POST's lock order.
        const deleted = await sequelize.transaction(async (transaction) => {
            const calculatedVideo = await lockVideoCalculated(models, vote.video_id, { transaction });
            const aiRow = await lockAiCalculated(models, vote.video_id, { transaction });

            const count = await models.Vote.destroy({ where: { id: vote.id }, transaction });
            if (!count) return false; // deleted concurrently: nothing left to undo

            const segment = { videoId: vote.video_id, categoryId: vote.category_id, start: vote.start, end: vote.end };
            if (aiRow) await recomputeAiSegmentRating(models, aiRow, segment, { transaction });
            if (calculatedVideo) await recomputeSegmentRating(models, segment, { transaction });

            await userService.updateRatingByVote({ ...vote.get({ plain: true }), vote: 0 }, vote, { transaction });
            return true;
        });
        if (!deleted) { res.status(404).send('Vote not found'); return; }

        res.status(201).send('Updated');
    }));

    // Token first, so a wrong token is a 401 even with a bad rating.
    router.get('/votes/user/:internal_user_id/update-rating', [
        verifyQueryToken,
        query('rating').isInt({ min: -2147483648, max: 2147483647 }).toInt(), // users.rating is INTEGER
        validateRequest,
    ],
    handler(async (req, res) => {
        const user = await models.User.findByPk(req.params.internal_user_id);
        if (!user) { res.status(404).send('Not found'); return; }

        const from = user.rating;
        await user.update({ rating: req.query.rating });
        console.log('Admin rating override', { internal_user_id: user.id, from, to: req.query.rating });

        res.status(201).send('Updated');
    }));

    return router;
};
