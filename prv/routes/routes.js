const express = require('express');
const router = express.Router();
const handler = require('../../middleware/handler');

router.get('/', (req, res, next) => {
    res.send({
        status: 'ok'
    })
})

router.get('/metrics', handler((req, res, next) => {
    res.set('Content-Type', metricsMiddleware.promClient.register.contentType);
    res.end(metricsMiddleware.promClient.register.metrics());
}))

router.get('/gdfgestshgergevcv3rwrf2e2e', handler((req, res, next) => {
    console.error('qqq1');
    console.log('qqq2');
    throw new Error('qqq3');
}))

module.exports = router;
