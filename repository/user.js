const db = require('../db');

const userRepository = {
    async findByGeneratedUserId(generatedUserId) {
        return await db.User.findOne({
            where: { generated_user_id: generatedUserId }
        });
    },
};

module.exports = userRepository;