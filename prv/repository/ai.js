module.exports = function createAiRepository(models, sequelize) {
    return {
        // GREATEST skips NULL, so a request without `views` never lowers or clears views_max.
        async seen(nativeId, views) {
            await sequelize.query(
                `INSERT INTO prv_ai_videos (native_id, views_max, requests)
                 VALUES (:nativeId, :views, 1)
                 ON CONFLICT (native_id) DO UPDATE SET
                     views_max = GREATEST(prv_ai_videos.views_max, EXCLUDED.views_max),
                     requests = prv_ai_videos.requests + 1,
                     last_seen_at = CURRENT_TIMESTAMP`,
                { replacements: { nativeId, views: views ?? null } });
        },
    };
};
