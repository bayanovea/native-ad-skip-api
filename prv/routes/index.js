const express = require('express');
const { prv: models, sequelize } = require('../../db');

const markupRepository = require('../repository/markup')(models, sequelize);
const markupTimeIntervalRepository = require('../repository/markup-time-interval')(models);
const durationLogRepository = require('../repository/duration-log')(models);
const videoRepository = require('../repository/video')(models);
// moderationRepository MUST be instantiated BEFORE userService — userService's
// auto-ban hook depends on it to record the auto-decision row at rating threshold.
const moderationRepository = require('../repository/moderation')(models, sequelize);
// Assessor review (/admin/review).
const reviewRepository = require('../repository/review')(models, sequelize);
const aiRepository = require('../repository/ai')(models, sequelize);
const userService = require('../service/user')(models, {
    markupRepository,
    markupTimeIntervalRepository,
    moderationRepository,
});

const router = express.Router();

router.use('/', require('./markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository }));
router.use('/', require('./videos')(models, { videoRepository, durationLogRepository, aiRepository }));
router.use('/', require('./votes')(models, { videoRepository, userService }));
router.use('/', require('./users')(models));
router.use('/', require('./events')(models));
router.use('/', require('./admin')(models, { markupRepository, aiRepository, reviewRepository }));
router.use('/', require('./admin-moderation')(models, { markupRepository, moderationRepository }));
router.use('/', require('./admin-review')(models, { reviewRepository, aiRepository }));

module.exports = router;
