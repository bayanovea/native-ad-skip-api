const express = require('express');
const router = express.Router();

router.get('/', (req, res, next) => {
    res.send({
        status: 'ok'
    })
})

module.exports = router;
