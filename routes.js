const express = require('express');
const router = express.Router();
const videoRepository = require('./repository/video_repository');
const videoCalculatedRepository = require('./repository/video_calculated_repository');
const Markup = require('./models/Markup');

router.get('/video-calculated', (req, res) => {
    if (!req.query.video_id || typeof req.query.video_id !== 'string') {
        res.status(400).send('Bad request');
        return;
    }

    videoCalculatedRepository.findByNativeVideoId(req.query.video_id)
        .then((video) => {
            if (!video) {
                res.status(404).send('Not found');
                return;
            }

            res.json(video);
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send('Internal server error');
        });
});

router.post('/markup', (req, res) => {
    if (!req.body.video_id || typeof req.body.video_id !== 'string') {
        res.status(400).send('Bad request');
        return;
    }
    if (!req.body.user_id || typeof req.body.user_id !== 'number') {
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
    
    let video = videoRepository.findOrCreate(req.body.video_id);

    sequelize.transaction(async (t) => {
        const Markup = Markup.create({
            video_id: video.id,
            user_id: req.body.user_id,
            category_id: req.body.category_id
        });
    
        data.intervals.forEach(interval => {
            const MarkupInterval = MarkupInterval.create({
                markup_id: Markup.id,
                start: interval.start,
                end: interval.end
            });
        });
    });

    res.status(201).send('Created');
});

module.exports = router;
