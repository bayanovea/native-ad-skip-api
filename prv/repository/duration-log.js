module.exports = function createDurationLogRepository(models) {
    return {
        async createOrIncrement(userId, videoId, duration) {
            const existing = await models.DurationLog.findOne({
                where: { user_id: userId, video_id: videoId },
            });

            if (existing) {
                await existing.increment('count');
                return existing;
            }

            return models.DurationLog.create({ user_id: userId, video_id: videoId, duration, count: 1 });
        },

        async findAll(options = {}) {
            return models.DurationLog.findAll(options);
        },

        async findByPk(id) {
            return models.DurationLog.findByPk(id);
        },

        async findByVideoId(videoId) {
            return models.DurationLog.findAll({ where: { video_id: videoId } });
        },

        async findByUserId(userId) {
            return models.DurationLog.findAll({ where: { user_id: userId } });
        },
    };
};
