const express = require('express');
const { rt: models, sequelize } = require('../../db');

const markupRepository = require('../repository/markup')(models, sequelize);
const markupTimeIntervalRepository = require('../repository/markup-time-interval')(models);
const videoRepository = require('../repository/video')(models);
const userService = require('../../prv/service/user')(models, { markupRepository, markupTimeIntervalRepository });

const router = express.Router();

router.use('/', require('./markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository }));
router.use('/', require('./videos')(models, { videoRepository }));
router.use('/', require('./votes')(models, { videoRepository, userService }));
router.use('/', require('../../prv/routes/users')(models));
router.use('/', require('../../prv/routes/events')(models));

module.exports = router;
