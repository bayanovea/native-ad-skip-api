const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const db = require('../db');
const prometheusWrapper = require('../prometheus-wrapper');
const validateRequest = require('../middleware/validate-request');
const verifyBearerToken = require('../middleware/verify-bearer-token');
const handler = require('../middleware/handler');
const markupRepository = require('../repository/markup');
const markupTimeIntervalRepository = require('../repository/markup-time-interval');
const userRepository = require('../repository/user');

/**
 * Create markup
 */
router.post('/markup', [
    body('video_id').isString(),
    body('user_id').isString(),
    body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('category_id').isInt({ min: 1 }),
    body('data').custom((value) => {
        if (typeof value !== 'object') {
            throw new Error('data must be an object');
        }
        return true;
    }),
    body('data.intervals').custom((value) => {
        if (!Array.isArray(value)) {
            throw new Error('data.intervals must be an array');
        }
        return true;
    }),
    validateRequest
],
handler(async (req, res) => {
    // TODO: Remove blacklist
    /** BLACKLIST */
    const blockedUserIds = [
        '689613b1-e95c-410a-8879-6745c72a0a9a',
        '3c0c4282-3d8b-4889-ae18-2da7284c8c5a',
        '86ebab8d-2309-4ade-882d-070a47953e0a',
        '58fd5104-c500-465b-8ab7-b8779056523a',
        '7bf55b02-5556-48fa-b6d3-928d10bfceaa',
        '15c2caeb-903f-4ce5-97f4-8e2d0b0a2398',
        'b4199ab6-100e-435d-b2a4-dbef1715155f',
        '9a661f94-8be8-44e3-b879-2a4dc81fcbc8'
    ];
    let videoId = req.body.video_id;
    const userId = req.body.user_id

    if (blockedUserIds.includes(userId)) {
        res.status(201).send('Created'); // fake response
        return;
    }

    // Crutch for old versions when frontend always send video id without minus
    if (!req.body.v) {
        prometheusWrapper.incrementRequestWithoutVersion('POST /markup', videoId);
        videoId = '-' + videoId;
    }

    const [video, created] = await db.Video.findOrCreate({
        where: { native_id: videoId }
    });

    let user = userRepository.findByGeneratedUserId(userId);
    if (!user) {
        user = await db.User.create({
            user_id: userId,
            prv_user_id: req.body.prv_user_id
        });
    }

    const markup = await db.Markup.create({
        video_id: video.id,
        user_id: userId,
        prv_user_id: req.body.prv_user_id,
        category_id: req.body.category_id,
        user_id: user.id
    });

    for (const interval of req.body.data.intervals) {
        const markupInterval = await db.MarkupTimeInterval.create({
            markup_id: markup.id,
            // Currently we support only integer values
            start: Math.round(interval.start),
            end: Math.round(interval.end)
        });
    }

    res.status(201).send('Created');
}))

/**
 * Edit markup
 */
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
    validateRequest
],
handler(async (req, res) => {
    let video = await db.Video.findOne({
        where: { native_id: req.body.video_id }
    });

    if (!video) {
        res.status(404).send('Not found');
        return;
    }

    // TODO: Find by table user
    let markups = await markupRepository.findAll({
        where: {
            video_id: video.id,
            user_id: req.body.user_id,
            category_id: req.body.category_id,
        }
    });

    if (markups.length === 0) {
        res.status(404).send('Not found');
        return;
    }

    let markupIds = markups.map(markup => markup.id);

    let markupInterval = await markupTimeIntervalRepository.findOne({
        where: {
            markup_id: markupIds,
            start: req.body.start,
            end: req.body.end
        }
    });

    if (!markupInterval) {
        res.status(404).send('Not found');
        return;
    }

    let newMarkupValues = { is_new: true };
    let newIntervalValues = {};

    if (req.body.new_category_id !== undefined) {
        let category = await db.MarkupCategory.findByPk(req.body.new_category_id);
        if (!category) {
            res.status(400).send('New category is invalid');
            return;
        }
        newMarkupValues.category_id = req.body.new_category_id;
    }

    if (req.body.new_start !== undefined) {
        newIntervalValues.start = req.body.new_start;
    }
    if (req.body.new_end !== undefined) {
        newIntervalValues.end = req.body.new_end;
    }

    await db.db.transaction(async (transaction) => {
        if (Object.keys(newIntervalValues).length !== 0) {
            await db.MarkupTimeInterval.update(newIntervalValues, {
                where: { id: markupInterval.id }
            });
        }

        await db.Markup.update(newMarkupValues, {
            where: { id: markupInterval.markup_id }
        });
    });

    res.status(200).send('Updated');
}))

/**
 * Admin edit markup.
 * Soft delete all old markups and create new admin markup.
 */
router.post('/admin/markups/edit', verifyBearerToken, [
    body('video_id').isString(),
    body('category_id').isInt({ min: 1 }),
    body('start').isInt({ min: 0 }),
    body('end').isInt({ min: 0 }),
    body('new_category_id').isInt({ min: 1 }),
    body('new_start').isInt({ min: 0 }),
    body('new_end').isInt({ min: 0 }),
    body('user_id').isString(),
    body('prv_user_id').optional().isInt({ min: 1 }),
    validateRequest
],
handler(async (req, res) => {
    const userId = req.body.user_id;
    const prvUserId = req.body.prv_user_id;

    let video = await db.Video.findOne({
        where: { native_id: req.body.video_id }
    });
    if (!video) {
        res.status(404).send('Video not found');
        return;
    }

    markupIds = await markupRepository.getIdsBySegmentData(video, req.body.category_id, req.body.start, req.body.end);

    await markupRepository.softDeleteByIds(markupIds, userId, prvUserId);

    // TODO: Find by table user
    await db.db.transaction(async (transaction) => {
        const markup = await db.Markup.create({
            video_id: video.id,
            user_id: userId,
            prv_user_id: prvUserId,
            category_id: req.body.new_category_id
        });

        await db.MarkupTimeInterval.create({
            markup_id: markup.id,
            start: req.body.new_start,
            end: req.body.new_end
        });
    });

    res.status(201).send('Created');
}))

/**
 * Get markups by filter
 */
router.get('/markups', verifyBearerToken, handler(async (req, res) => {
    let markups = await markupRepository.findByRequest(req);
    res.status(200).send(markups);
}))

/**
 * Delete markup
 */
router.delete('/markups/:id', verifyBearerToken, handler(async (req, res) => {
    const markupId = req.params.id;

    let markup = await markupRepository.findByPk(markupId)
    if (!markup) {
        res.status(404).send('Not found ' . markupId );
        return;
    }

    await markupRepository.softDeleteByIds([markupId], 'admin', 1);

    let videoMarkups = await markupRepository.findAll({
        where: { video_id: markup.video_id }
    });

    if (videoMarkups.length > 0) {
        // Update rest markups as new for recalculating without deleted markup
        await db.Markup.update(
            { is_new: true },
            { where: { video_id: markup.video_id } }
        );
    } else {
        // Don't need to recalculate video because there are no markups, so delete calculated data
        await db.VideoCalculated.destroy({
            where: { video_id: markup.video_id }
        });
    }

    res.status(201).send('Deleted');
}))

/**
 * Delete markup via GET (DUPLICATE)
 *
 * TODO: NEED THIS DUPLICATE BECAUSE OF GRAFANA, AFTER FIXING GRAFANA NEED TO DELETE THIS
 */
router.get('/markups/:id/delete', handler(async (req, res) => {
    const markupId = req.params.id;

    if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
        res.status(401).send('Unauthorized');
        return;
    }

    let markup = await markupRepository.findByPk(markupId)
    if (!markup) {
        res.status(404).send('Not found ' . markupId );
        return;
    }

    await markupRepository.softDeleteByIds([markupId], 'admin', 1);

    let videoMarkups = await markupRepository.findAll({
        where: { video_id: markup.video_id }
    });

    if (videoMarkups.length > 0) {
        // Update rest markups as new for recalculating without deleted markup
        await db.Markup.update(
            { is_new: true },
            { where: { video_id: markup.video_id } }
        );
    } else {
        // Don't need to recalculate video because there are no markups, so delete calculated data
        await db.VideoCalculated.destroy({
            where: { video_id: markup.video_id }
        });
    }

    res.status(201).send('Deleted');
}))

/**
 * Delete video's markups
 */
router.delete('/videos/:id/markups', verifyBearerToken, handler(async (req, res) => {
    let videoId = req.params.id;

    // Check if passed video native id
    if (isNaN(videoId)) {
        let video = await db.Video.findOne({
            where: { native_id: videoId }
        });

        if (!video) {
            res.status(404).send('Not found');
            return;
        }

        videoId = video.id;
    }

    // Collect all markups, intervals ids for common delete query
    let videoMarkups = await markupRepository.findAll({
        where: { video_id: String(videoId) }
    });
    markupIds = videoMarkups.map(markup => markup.id);

    let markupIntervals = await markupTimeIntervalRepository.findAll({
        where: { markup_id: markupIds }
    });
    markupIntervalIds = markupIntervals.map(interval => interval.id);

    // Delete all markups, intervals, calculated data
    await db.db.transaction(async (transaction) => {
        await db.MarkupTimeInterval.destroy({
            where: { id: markupIntervalIds },
            transaction
        });

        await db.Markup.destroy({
            where: { id: markupIds },
            transaction
        });

        await db.VideoCalculated.destroy({
            where: { video_id: videoId },
            transaction
        });
    });

    res.status(201).send('Deleted');
}))

module.exports = router;
