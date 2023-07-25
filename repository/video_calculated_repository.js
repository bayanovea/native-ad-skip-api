const db = require('../db');

const findByNativeVideoId = (video_native_id) => {
  // TODO: db.Video.findOne is not a function
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

module.exports = { findByNativeVideoId }
