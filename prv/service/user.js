// Auto-ban threshold — when a user's rating drops to this value (or below), the
// user is automatically banned (banned_at set) and a `prv_admin_decisions` row is
// written with decided_by='auto'. Mirrors AUTO_BAN_RATING_THRESHOLD in
// prv/routes/admin-moderation.js (kept as a local literal so the service is
// standalone — that file is the source of truth for the constant).
const AUTO_BAN_RATING_THRESHOLD = -100;

module.exports = function createUserService(
    models,
    { markupRepository, markupTimeIntervalRepository, moderationRepository }
) {
    return {
        async updateRatingByVote(vote, prevVote) {
            const diffCount = prevVote ? vote.vote - prevVote.vote : vote.vote;
            if (!diffCount) return;

            const markups = await markupRepository.findAll({
                where: { category_id: vote.category_id, video_id: vote.video_id },
            });

            const usersToUpdate = new Map();

            for (const markup of markups) {
                const internalUserId = markup.internal_user_id;
                if (usersToUpdate.has(internalUserId)) continue;

                const markupTimeInterval = await markupTimeIntervalRepository.findOne({
                    where: { markup_id: markup.id, start: vote.start, end: vote.end },
                });

                if (!markupTimeInterval) continue;
                usersToUpdate.set(internalUserId, vote.vote);
            }

            for (const [internalUserId] of usersToUpdate) {
                const user = await models.User.findByPk(internalUserId);
                if (!user) continue;
                await user.increment('rating', { by: diffCount });

                // Auto-ban hook is prv-only; rt/yt do not wire moderationRepository
                // (their users tables don't have banned_at, and moderationRepository
                // targets prv_-prefixed tables only). If absent, skip the entire block.
                if (!moderationRepository) continue;

                // Reload to get the fresh rating (increment doesn't refresh the
                // in-memory instance), then check for a fresh downward crossing
                // of the threshold. Crossing-only: only fire when this vote
                // moves the user from >-100 to <=-100. Prevents the hook from
                // re-banning a user immediately after an admin unbans them
                // (their rating may still be deeply negative; an admin's
                // approve must be durable). Uses the same `recordDecision`
                // entrypoint as the admin POST endpoint (locked architecture).
                await user.reload();
                const previousRating = user.rating - diffCount;
                const isFreshCrossing = previousRating > AUTO_BAN_RATING_THRESHOLD
                    && user.rating <= AUTO_BAN_RATING_THRESHOLD;
                if (isFreshCrossing && user.banned_at == null) {
                    await user.update({ banned_at: new Date() });
                    // Race-accepted: concurrent crossings may produce duplicate 'auto' decision rows; getLatestDecisionsMap picks the newest, so the duplicate is at worst noise in history. Adding a partial unique index here would also block legitimate re-bans after admin unbans.
                    await moderationRepository.recordDecision({
                        target_type: 'user',
                        target_id: user.id,
                        decision: 'reject',
                        decided_by: 'auto',
                    });
                }
            }
        },
    };
};
