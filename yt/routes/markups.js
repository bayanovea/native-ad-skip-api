const express = require('express');
const { body } = require('express-validator');
const validateRequest = require('../../middleware/validate-request');
const verifyBearerToken = require('../../middleware/verify-bearer-token');
const handler = require('../../middleware/handler');
const { validateIntervals } = require('../../lib/validate-intervals');

const IGNORE_MARKUPS_USER_RATING_VAL = -2;

module.exports = function createMarkupRoutes(models, { markupRepository, markupTimeIntervalRepository, videoRepository }) {
    const router = express.Router();
    const sequelize = models.Markup.sequelize;

    router.post('/markup', [
        body('video_id').isString(),
        body('user_id').isString(),
        body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
        body('category_id').isInt({ min: 1 }),
        body('data').custom((value) => {
            if (typeof value !== 'object') throw new Error('data must be an object');
            return true;
        }),
        body('data.intervals').custom(validateIntervals),
        body('duration').isInt({ min: 1 }),
        validateRequest,
    ],
    handler(async (req, res) => {
        const videoId = req.body.video_id;
        const generatedUserId = req.body.user_id;

        const video = await videoRepository.findByNativeIdAndDuration(videoId, req.body.duration);

        const [user] = await models.User.findOrCreate({
            where: { generated_user_id: generatedUserId, prv_user_id: req.body.prv_user_id ?? null },
        });

        if (user.rating <= IGNORE_MARKUPS_USER_RATING_VAL) {
            console.warn('Do not create markup because of bad user rating', {
                generatedUserId,
                prvUserId: req.body.prv_user_id,
                videoId,
                categoryId: req.body.category_id,
                intervals: req.body.data.intervals,
            });
            res.status(201).send('Created');
            return;
        }

        // Note: banned-user gate is prv-only by design — yt_users has no banned_at column;
        // moderation tooling and the banned_at column exist only for the prv users table.

        // One transaction, so the calculator never sees the markup with only some of its intervals.
        await sequelize.transaction(async (transaction) => {
            const markup = await models.Markup.create({
                video_id: video.id,
                user_id: generatedUserId,
                prv_user_id: req.body.prv_user_id,
                category_id: req.body.category_id,
                internal_user_id: user.id,
            }, { transaction });

            for (const interval of req.body.data.intervals) {
                await models.MarkupTimeInterval.create({
                    markup_id: markup.id,
                    start: Math.round(Number(interval.start)),
                    end: Math.round(Number(interval.end)),
                }, { transaction });
            }
        });

        res.status(201).send('Created');
    }));

    router.put('/markups', [
        body('video_id').isString(),
        body('user_id').isString(),
        body('prv_user_id').optional().isInt({ min: 1 }),
        body('category_id').isInt({ min: 1 }),
        body('start').isInt({ min: 0 }),
        body('end').isInt({ min: 0 }),
        body('new_category_id').optional().isInt({ min: 1 }),
        body('new_start').optional().isInt({ min: 0 }),
        body('new_end').optional().isInt({ min: 0 }),
        body('duration').isInt({ min: 1 }),
        validateRequest,
    ],
    handler(async (req, res) => {
        const video = await models.Video.findOne({ where: { native_id: req.body.video_id } });
        if (!video) { res.status(404).send('Not found'); return; }

        if (req.body.duration != null) {
            await video.update({ duration: req.body.duration });
        }

        const markups = await markupRepository.findAll({
            where: { video_id: video.id, user_id: req.body.user_id, category_id: req.body.category_id },
        });
        if (markups.length === 0) { res.status(404).send('Not found'); return; }

        const markupInterval = await markupTimeIntervalRepository.findOne({
            where: { markup_id: markups.map(m => m.id), start: req.body.start, end: req.body.end },
        });
        if (!markupInterval) { res.status(404).send('Not found'); return; }

        const newMarkupValues = { is_new: true };
        const newIntervalValues = {};

        if (req.body.new_category_id !== undefined) {
            const category = await models.MarkupCategory.findByPk(req.body.new_category_id);
            if (!category) { res.status(400).send('New category is invalid'); return; }
            newMarkupValues.category_id = req.body.new_category_id;
        }
        if (req.body.new_start !== undefined) newIntervalValues.start = req.body.new_start;
        if (req.body.new_end !== undefined) newIntervalValues.end = req.body.new_end;

        await sequelize.transaction(async (transaction) => {
            if (Object.keys(newIntervalValues).length) {
                await models.MarkupTimeInterval.update(newIntervalValues, { where: { id: markupInterval.id } });
            }
            await models.Markup.update(newMarkupValues, { where: { id: markupInterval.markup_id } });
        });

        res.status(200).send('Updated');
    }));

    router.get('/markups', verifyBearerToken, handler(async (req, res) => {
        const markups = await markupRepository.findByRequest(req);
        res.status(200).send(markups);
    }));

    router.delete('/markups/:id', verifyBearerToken, handler(async (req, res) => {
        const markupId = req.params.id;
        const markup = await markupRepository.findByPk(markupId);
        if (!markup) { res.status(404).send('Not found'); return; }

        if (req.body.duration != null) {
            await models.Video.update({ duration: req.body.duration }, { where: { id: markup.video_id } });
        }

        await markupRepository.softDeleteByIds([markupId], 'admin', 1);

        const videoMarkups = await markupRepository.findAll({ where: { video_id: markup.video_id } });
        if (videoMarkups.length > 0) {
            await models.Markup.update({ is_new: true }, { where: { video_id: markup.video_id } });
        } else {
            await models.VideoCalculated.destroy({ where: { video_id: markup.video_id } });
        }

        res.status(201).send('Deleted');
    }));

    // GET duplicate for Grafana compatibility
    router.get('/markups/:id/delete', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const markupId = req.params.id;
        const markup = await markupRepository.findByPk(markupId);
        if (!markup) { res.status(404).send('Not found'); return; }

        if (req.body.duration != null) {
            await models.Video.update({ duration: req.body.duration }, { where: { id: markup.video_id } });
        }

        await markupRepository.softDeleteByIds([markupId], 'admin', 1);

        const videoMarkups = await markupRepository.findAll({ where: { video_id: markup.video_id } });
        if (videoMarkups.length > 0) {
            await models.Markup.update({ is_new: true }, { where: { video_id: markup.video_id } });
        } else {
            await models.VideoCalculated.destroy({ where: { video_id: markup.video_id } });
        }

        res.status(201).send('Deleted');
    }));

    router.delete('/videos/:id/markups', verifyBearerToken, handler(async (req, res) => {
        let videoId = req.params.id;

        if (isNaN(videoId)) {
            const video = await models.Video.findOne({ where: { native_id: videoId } });
            if (!video) { res.status(404).send('Not found'); return; }
            videoId = video.id;
        }

        const videoMarkups = await markupRepository.findAll({ where: { video_id: String(videoId) } });
        const markupIds = videoMarkups.map(m => m.id);

        const markupIntervals = await markupTimeIntervalRepository.findAll({ where: { markup_id: markupIds } });
        const markupIntervalIds = markupIntervals.map(i => i.id);

        await sequelize.transaction(async (transaction) => {
            await models.MarkupTimeInterval.destroy({ where: { id: markupIntervalIds }, transaction });
            await models.Markup.destroy({ where: { id: markupIds }, transaction });
            await models.VideoCalculated.destroy({ where: { video_id: videoId }, transaction });
        });

        res.status(201).send('Deleted');
    }));

    return router;
};
