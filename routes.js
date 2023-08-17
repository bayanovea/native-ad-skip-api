const express = require('express');
const router = express.Router();
const db = require('./db');

router.get('/', (req, res, next) => {
    res.send({
        status: 'ok'
    })
})

router.get('/video-calculated', async (req, res) => {
    try {
        if (!req.query.video_id || typeof req.query.video_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }

        const video = await db.Video.findOne({
            where: { native_id: req.query.video_id }
        });

        if (!video) {
            res.status(404).send('Not found');
            return;
        }

        const markups = await db.Markup.findAll({
            where: { video_id: String(video.id) }
        });

        let resData = [];

        for (const markup of markups) {
            const markupTimeIntervals = await db.MarkupTimeInterval.findAll({
                where: { markup_id: String(markup.id) }
            });

            for (const markupTimeInterval of markupTimeIntervals) {
                resData.push({
                    category_id: markup.category_id,
                    start: markupTimeInterval.start,
                    end: markupTimeInterval.end
                });
            }
        }

        console.log(resData);
        res.status(200).send(resData);

    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/markup', async (req, res) => {
    try {
        if (!req.body.video_id || typeof req.body.video_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.user_id || typeof req.body.user_id !== 'string') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.data || typeof req.body.data !== 'object') {
            res.status(400).send('Bad request');
            return;
        }
        if (!req.body.data.intervals) {
            res.status(400).send('Bad request');
            return;
        }

        const [video, created] = await db.Video.findOrCreate({
            where: { native_id: req.body.video_id }
        });

        const markup = await db.Markup.create({
            video_id: video.id,
            user_id: req.body.user_id,
            category_id: req.body.category_id
        });

        for (const interval of req.body.data.intervals) {
            const markupInterval = await db.MarkupTimeInterval.create({
                markup_id: markup.id,
                start: interval.start,
                end: interval.end
            });

            console.log(markupInterval);
        }

        res.status(201).send('Created');

    } catch (error) {
        console.error('Failed to create a new record : ', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
