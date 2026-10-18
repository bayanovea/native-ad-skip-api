const { durationMatchQuery } = require('../../lib/duration-tolerance');

module.exports = function createVideoRepository(models) {
    return {
        async findByNativeIdAndDuration(nativeId, duration) {
            if (duration != null) {
                let video = await models.Video.findOne(durationMatchQuery(models, nativeId, duration));

                if (!video) {
                    video = await models.Video.findOne({ where: { native_id: nativeId, duration: null } });

                    if (video) {
                        await video.update({ duration });
                    } else {
                        video = await models.Video.create({ native_id: nativeId, duration });
                    }
                }

                return video;
            }

            let video = await models.Video.findOne({ where: { native_id: nativeId } });
            if (!video) {
                video = await models.Video.create({ native_id: nativeId });
            }
            return video;
        },
    };
};
