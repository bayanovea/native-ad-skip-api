const express = require('express');
const { prv: models, sequelize } = require('../../db');
const createProviderRouter = require('./provider-router');

const markupRepository = require('../repository/markup')(models, sequelize);
const moderationRepository = require('../repository/moderation')(models, sequelize);
// Assessor review (/admin/review).
const reviewRepository = require('../repository/review')(models, sequelize);
const aiRepository = require('../repository/ai')(models, sequelize);

const router = express.Router();

router.use('/', createProviderRouter(models, 'prv', {
    durationLogRepository: require('../repository/duration-log')(models),
    aiRepository,
    moderationRepository,
    legacyUnversioned: true,
}));
router.use('/', require('./admin')(models, { markupRepository, aiRepository, reviewRepository }));
router.use('/', require('./admin-moderation')(models, { markupRepository, moderationRepository }));
router.use('/', require('./admin-review')(models, { reviewRepository, aiRepository }));

module.exports = router;
