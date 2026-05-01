const express = require('express');
const bodyParser = require('body-parser');
const routes = require('./prv/routes/routes');

const app = express();
const port = process.env.NODE_APP_PORT;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const promBundle = require('express-prom-bundle');
const metricsMiddleware = promBundle({ includeMethod: true, includePath: true });
app.use(metricsMiddleware);

app.set('trust proxy', true);

app.use(function (req, res, next) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type, Accept');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
});

app.use('/', routes);
app.use('/', require('./prv'));
app.use('/rt', require('./rt'));
app.use('/yt', require('./yt'));

app.use((error, req, res, next) => {
    console.error('Error: ', {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        params: req.params,
        query: req.query,
        error,
    });
    res.status(500).send('Internal Server Error');
});

app.listen(port, () => {
    console.log(`I am alive, http://localhost:${port}`);
});
