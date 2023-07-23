const db = require('../db');

function findByNativeVideoId(video_native_id) {
    return db.Video.findOne({
        where: {
            native_id: video_native_id
        },
        include: [{
            model: db.VideoCalculated,
            as: 'video_calculated',
            required: true
        }]
    });
}
