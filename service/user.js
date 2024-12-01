const db = require('../db');
const markupRepository = require('../repository/markup');
const markupTimeIntervalRepository = require('../repository/markup-time-interval');

const userService = {
    async updateRatingByVote(vote, prevVote) {
        let diffCount = prevVote ? vote.vote - prevVote.vote : vote.vote;

        if (!diffCount) {
            return;
        }

        const markups = await markupRepository.findAll({
            where: {
                category_id: vote.category_id,
                video_id: vote.video_id
            }
        });
    
        const usersToUpdate = new Map();

        for (let i = 0; i < markups.length; i++) {
            const markup = markups[i];
            const internalUserId = markup.internal_user_id;

            if (usersToUpdate.has(internalUserId)) {
                continue;
            }

            const markupTimeInterval = await markupTimeIntervalRepository.findOne({
                where: {
                    markup_id: markup.id,
                    start: vote.start,
                    end: vote.end
                }
            });

            if (!markupTimeInterval) {
                continue;
            }

            usersToUpdate.set(internalUserId, vote.vote);
        }

        for (const [internalUserId] of usersToUpdate) {
            let user = await db.User.findByPk(internalUserId);
            if (!user) {
                continue;
            }

            await user.increment('rating', { by: diffCount });
        }
    },
};

module.exports = userService;