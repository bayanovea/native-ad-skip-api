const { Op } = require('sequelize');
const db = require('../db');

/**
 * @param {string} nativeId
 * @param {number|null} duration
 * @param {{ create?: boolean }} options - create: create a new video if none found (default: false, falls back to findOne by native_id)
 */
async function findByNativeIdAndDuration(nativeId, duration) {
    if (duration != null) {
        let video = await db.Video.findOne({
            where: { native_id: nativeId, duration: { [Op.between]: [duration - 1, duration + 1] } }
        });

        if (!video) {   
            video = await db.Video.findOne({ where: { native_id: nativeId, duration: null } });

            if (video) {
                await video.update({ duration });
            }
            
            video = await db.Video.create({ native_id: nativeId, duration });
        }

        return video;
    }

    let video = await db.Video.findOne({ where: { native_id: nativeId } });
    if (!video) {
        video = await db.Video.create({ native_id: nativeId });
    }

    return video;
}

module.exports = { findByNativeIdAndDuration };
