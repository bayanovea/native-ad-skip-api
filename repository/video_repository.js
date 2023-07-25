// const db = require('../db');
const Video = require('../models/video')

const findOrCreate = async (video_native_id) => {
  // TODO: Video.findOrCreate is not a function
  const [user, created] = await Video.findOrCreate({
    where: {
      native_id: video_native_id
    }
  });
}

module.exports = { findOrCreate }
