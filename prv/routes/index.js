const express = require('express');
const { prv: models, sequelize } = require('../../db');

const markupRepository = require('../repository/markup')(models, sequelize);
const markupTimeIntervalRepository = require('../repository/markup-time-interval')(models);
const durationLogRepository = require('../repository/duration-log')(models);
const videoRepository = require('../repository/video')(models);
const userService = require('../service/user')(models, { markupRepository, markupTimeIntervalRepository });

const router = express.Router();

router.use('/', require('./markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository }));
router.use('/', require('./videos')(models, { videoRepository, durationLogRepository }));
router.use('/', require('./votes')(models, { videoRepository, userService }));
router.use('/', require('./users')(models));
router.use('/', require('./events')(models));
router.use('/', require('./admin')(models, { markupRepository }));

module.exports = router;
