const express = require('express');
const { body, query } = require('express-validator');
const validateRequest = require('../../middleware/validate-request');
const verifyQueryToken = require('../../middleware/verify-query-token');
const handler = require('../../middleware/handler');
const { lockVideoCalculated, recomputeSegmentRating, recomputeAiSegmentRating } = require('../../lib/segment-rating');
const { lockAiCalculated, servesAi } = require('../../lib/find-ai-calculated');

// The vote as the markup authors see it: a vote on an AI entry is about no human's interval,
// even one with the same bounds, so it moves no author's rating.
const authorsVote = (vote) => (vote && !vote.ai ? vote.vote : 0);

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
        // VideoCalculated. The row locks serialise votes on the video with each
        // other, with a recalculation (`calculate`, `--recompute-ratings`) and
        // with a withdraw / review change of the AI row.
        const found = await sequelize.transaction(async (transaction) => {
            const aiRow = await lockAiCalculated(models, video.id, { transaction });
            const onAi = duration != null && servesAi(aiRow);
            const calculatedVideo = onAi ? aiRow : await lockVideoCalculated(models, video.id, { transaction });
            if (!calculatedVideo) return false;

            const segment = (calculatedVideo.data || []).find(item =>
                item.category_id === categoryId && item.start === start && item.end === end);
            if (!segment) return false;

            const prevVote = await models.Vote.findOne({
                where: { user_id: userId, video_id: video.id, category_id: categoryId, start, end },
                transaction,
            });

            const voteObj = await models.Vote.create({
                user_id: userId,
                prv_user_id: req.body.prv_user_id,
                video_id: video.id,
                category_id: categoryId,
                start,
                end,
                vote,
                ai: onAi,
            }, { transaction });

            if (prevVote) await prevVote.destroy({ transaction });

            if (aiRow) await recomputeAiSegmentRating(models, aiRow, { categoryId, start, end }, { transaction });
            if (!onAi) await recomputeSegmentRating(models, { videoId: video.id, categoryId, start, end }, { transaction });

            await userService.updateRatingByVote({ ...voteObj.get({ plain: true }), vote: authorsVote(voteObj) },
                { vote: authorsVote(prevVote) }, { transaction });
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
        // rating was never touched, so it is left alone). The vote may predate
        // the AI row, so both are recomputed; the AI row is locked before
        // VideoCalculated (no writer takes them the other way round).
        const deleted = await sequelize.transaction(async (transaction) => {
            const aiRow = await lockAiCalculated(models, vote.video_id, { transaction });
            const calculatedVideo = await lockVideoCalculated(models, vote.video_id, { transaction });

            const count = await models.Vote.destroy({ where: { id: vote.id }, transaction });
            if (!count) return false; // deleted concurrently: nothing left to undo

            const segment = { videoId: vote.video_id, categoryId: vote.category_id, start: vote.start, end: vote.end };
            if (aiRow) await recomputeAiSegmentRating(models, aiRow, segment, { transaction });
            if (calculatedVideo) await recomputeSegmentRating(models, segment, { transaction });

            await userService.updateRatingByVote({ ...vote.get({ plain: true }), vote: 0 }, { vote: authorsVote(vote) }, { transaction });
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
