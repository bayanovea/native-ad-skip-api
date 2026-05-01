const express = require('express');
const { body } = require('express-validator');
const validateRequest = require('../../middleware/validate-request');
const handler = require('../../middleware/handler');

module.exports = function createUserRoutes(models) {
    const router = express.Router();

    router.post('/users/time-saved', [
        body('user_id').isString(),
        body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
        body('inc').optional({ nullable: true }).isInt({ min: 0 }),
        validateRequest,
    ],
    handler(async (req, res) => {
        const { user_id, prv_user_id, inc } = req.body;

        const [user] = await models.User.findOrCreate({
            where: { generated_user_id: user_id, prv_user_id: prv_user_id ?? null },
        });

        if (inc != null) {
            await user.increment('time_saved', { by: inc });
        }

        const [byUserId, byPrvUserId] = await Promise.all([
            models.User.findAll({ where: { generated_user_id: user_id }, attributes: ['time_saved'] }),
            prv_user_id != null
                ? models.User.findAll({ where: { prv_user_id }, attributes: ['time_saved'] })
                : Promise.resolve([]),
        ]);

        if (inc != null) await user.reload();

        res.send({
            time_user_id: byUserId.reduce((sum, row) => sum + (row.time_saved || 0), 0),
            time_prv_user_id: byPrvUserId.reduce((sum, row) => sum + (row.time_saved || 0), 0),
            time_saved: user.time_saved,
        });
    }));

    return router;
};
