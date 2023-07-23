const db = require('../db');

function findOrCreate(video_native_id) {
    return db.Video.findOrCreate({
        where: {
            native_id: video_native_id
        }
    });
}
