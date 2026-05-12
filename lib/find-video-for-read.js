const { Op } = require('sequelize');

async function findVideoForReadWithOutcome(models, nativeId, duration) {
    if (duration != null) {
        let video = await models.Video.findOne({
            where: { native_id: nativeId, duration: { [Op.between]: [duration - 1, duration + 1] } },
        });
        if (video) return { video, outcome: 'match' };

        video = await models.Video.findOne({ where: { native_id: nativeId, duration: null } });
        if (video) {
            await video.update({ duration });
            return { video, outcome: 'backfilled' };
        }

        video = await models.Video.findOne({ where: { native_id: nativeId } });
        if (video) return { video, outcome: 'mismatch' };
        return { video: null, outcome: 'not_found' };
    }

    const video = await models.Video.findOne({ where: { native_id: nativeId } });
    if (video) return { video, outcome: 'no_duration' };
    return { video: null, outcome: 'not_found' };
}

module.exports = { findVideoForReadWithOutcome };
