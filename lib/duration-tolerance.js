const { Op } = require('sequelize');

// ±2 and not ±3: prv's duration metadata jitters by 2 s for identical content (the five split families on
// prod); the one 3-s family is left split on purpose. docs/research/20260925-duration-split-analysis.md
const DURATION_TOLERANCE = 2;

// Read (lib/find-video-for-read.js) and write ({prv,rt,yt}/repository/video.js) lookups share this query,
// so a duration that fits two rows of an old split pair always lands on the same one: the closest, then the oldest.
function durationMatchQuery(models, nativeId, duration) {
    const n = Number(duration);
    if (!Number.isFinite(n)) throw new TypeError(`duration must be a finite number, got ${duration}`);
    return {
        where: { native_id: nativeId, duration: { [Op.between]: [n - DURATION_TOLERANCE, n + DURATION_TOLERANCE] } },
        order: [[models.Video.sequelize.literal(`ABS(duration - ${n})`), 'ASC'], ['id', 'ASC']],
    };
}

module.exports = { DURATION_TOLERANCE, durationMatchQuery };
