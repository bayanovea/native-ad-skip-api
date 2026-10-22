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

        // Unpublish the video's AI row (`by`: judge | review | admin | duration); `data` stays for the record.
        // Returns false when there is no row or it is already withdrawn.
        async withdraw(videoId, by, reason, { transaction } = {}) {
            const run = async (t) => {
                const [rows] = await sequelize.query(
                    `UPDATE prv_ai_video_calculateds
                     SET withdrawn_at = NOW(), withdrawn_by = :by, withdrawn_reason = :reason, updated_at = NOW()
                     WHERE video_id = :videoId AND withdrawn_at IS NULL
                     RETURNING native_id`,
                    { replacements: { videoId, by, reason: reason ?? null }, transaction: t });
                if (!rows.length) return false;
                await sequelize.query(
                    `UPDATE prv_ai_videos SET status = 'withdrawn', updated_at = NOW() WHERE native_id = :nativeId`,
                    { replacements: { nativeId: rows[0].native_id }, transaction: t });
                return true;
            };
            return transaction ? run(transaction) : sequelize.transaction(run);
        },
    };
};
