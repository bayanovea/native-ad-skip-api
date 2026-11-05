const express = require('express');

// The router of a provider other than prv: the prv route modules over its own models and the prv
// repositories; `provider` labels the metrics. What needs a prv-only model is skipped by its absence.
module.exports = function createProviderRouter(models, provider) {
    const sequelize = models.Markup.sequelize;
    const markupRepository = require('../repository/markup')(models, sequelize);
    const markupTimeIntervalRepository = require('../repository/markup-time-interval')(models);
    const videoRepository = require('../repository/video')(models);
    const userService = require('../service/user')(models, { markupRepository, markupTimeIntervalRepository });

    const router = express.Router();
    router.use('/', require('./markups')(models, { markupRepository, markupTimeIntervalRepository, videoRepository, provider }));
    router.use('/', require('./videos')(models, { videoRepository, provider }));
    router.use('/', require('./votes')(models, { videoRepository, userService }));
    router.use('/', require('./users')(models));
    router.use('/', require('./events')(models));
    return router;
};
