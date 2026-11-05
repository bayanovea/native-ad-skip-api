const express = require('express');

// The public routes of every provider: the prv route modules over the provider's own models and the
// prv repositories; `provider` labels the metrics. prv passes its prv-only deps; what another provider
// lacks is skipped by its absence (no aiRepository, no moderationRepository, no AI models).
module.exports = function createProviderRouter(models, provider,
    { durationLogRepository, aiRepository, moderationRepository, legacyUnversioned = false } = {}) {
    const sequelize = models.Markup.sequelize;
    const markupRepository = require('../repository/markup')(models, sequelize);
    const markupTimeIntervalRepository = require('../repository/markup-time-interval')(models);
    const videoRepository = require('../repository/video')(models);
    // moderationRepository: the auto-ban hook records its decision row through it.
    const userService = require('../service/user')(models, { markupRepository, markupTimeIntervalRepository, moderationRepository });

    const router = express.Router();
    router.use('/', require('./markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository, provider, legacyUnversioned }));
    router.use('/', require('./videos')(models, { videoRepository, durationLogRepository, aiRepository, provider, legacyUnversioned }));
    router.use('/', require('./votes')(models, { videoRepository, userService }));
    router.use('/', require('./users')(models));
    router.use('/', require('./events')(models));
    return router;
};
