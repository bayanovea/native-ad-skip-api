const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { Op } = require('sequelize');
const db = require('../db');
const validateRequest = require('../middleware/validate-request');
const handler = require('../middleware/handler');

router.post('/users/time-saved', [
    body('user_id').isString(),
    body('prv_user_id').optional({ nullable: true }).isInt({ min: 1 }),
    body('inc').optional({ nullable: true }).isInt({ min: 0 }),
    validateRequest
],
handler(async (req, res) => {
    const { user_id, prv_user_id, inc } = req.body;

    const user = await db.User.findOne({
        where: {
            generated_user_id: user_id,
            prv_user_id: prv_user_id ?? null
        }
    });

    if (!user) {
        res.status(404).send('User not found');
        return;
    }

    if (inc != null) {
        await user.increment('time_saved', { by: inc });
    }

    const allRows = await db.User.findAll({
        where: { generated_user_id: user_id },
        attributes: ['time_saved']
    });

    const totalTimeSaved = allRows.reduce((sum, row) => sum + (row.time_saved || 0), 0);

    if (inc != null) {
        await user.reload();
    }

    res.send({
        time_user_id: totalTimeSaved,
        time_prv_user_id: user.time_saved
    });
}))

module.exports = router;
