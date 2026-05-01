module.exports = function createUserService(models, { markupRepository, markupTimeIntervalRepository }) {
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
            }
        },
    };
};
