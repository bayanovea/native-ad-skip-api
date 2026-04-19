const db = require('../db');

const durationLogRepository = {
    async createOrIncrement(userId, videoId, duration) {
        const existing = await db.DurationLog.findOne({
            where: { user_id: userId, video_id: videoId },
        });

        if (existing) {
            await existing.increment('count');
            return existing;
        }

        return db.DurationLog.create({
            user_id: userId,
            video_id: videoId,
            duration,
            count: 1,
        });
    },

    async findAll(options = {}) {
        return db.DurationLog.findAll(options);
    },

    async findByPk(id) {
        return db.DurationLog.findByPk(id);
    },

    async findByVideoId(videoId) {
        return db.DurationLog.findAll({
            where: { video_id: videoId },
        });
    },

    async findByUserId(userId) {
        return db.DurationLog.findAll({
            where: { user_id: userId },
        });
    },
};

module.exports = durationLogRepository;
