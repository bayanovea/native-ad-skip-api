const express = require('express');
const { rt: models, sequelize } = require('../../db');

const markupRepository = require('../../prv/repository/markup')(models, sequelize);
const markupTimeIntervalRepository = require('../../prv/repository/markup-time-interval')(models);
const videoRepository = require('../../prv/repository/video')(models);
const userService = require('../../prv/service/user')(models, { markupRepository, markupTimeIntervalRepository });

const router = express.Router();

router.use('/', require('../../prv/routes/markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository, provider: 'rt' }));
router.use('/', require('../../prv/routes/videos')(models, { videoRepository, provider: 'rt' }));
router.use('/', require('../../prv/routes/votes')(models, { videoRepository, userService }));
router.use('/', require('../../prv/routes/users')(models));
router.use('/', require('../../prv/routes/events')(models));

module.exports = router;
