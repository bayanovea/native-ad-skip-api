const express = require('express');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const fs = require('fs');
const promClient = require('prom-client');
const routes = require('./prv/routes/routes');
const { sequelize, bootstrap } = require('./db');
const { redactRequest } = require('./lib/redact-request');
const { registerCalculatorHeartbeat } = require('./prometheus-wrapper');

const app = express();
const port = process.env.NODE_APP_PORT;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const promBundle = require('express-prom-bundle');
const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    autoregister: false,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
    excludeRoutes: [/^\/metrics(\/|$)/],
    normalizePath: [
        [/^\/admin\/video\/[^/]+\/user\/\d+$/, '/admin/video/#video_id/user/#prv_user_id'],
        [/^\/admin\/video\/[^/]+$/, '/admin/video/#video_id'],
        [/^\/admin\/user\/\d+$/, '/admin/user/#internal_id'],
        [/^\/admin\/review\/(?!(decide|reviewers)$)[^/]+$/, '/admin/review/#batch'],
        [/^\/admin\/review\/[^/]+\/(take|release)$/, '/admin/review/#batch/$1'],
        [/^\/admin\/markups\/\d+\/delete$/, '/admin/markups/#id/delete'],
        [/^(\/(rt|yt))?\/markups\/\d+\/delete$/, '$1/markups/#id/delete'],
        [/^(\/(rt|yt))?\/markups\/\d+$/, '$1/markups/#id'],
        [/^(\/(rt|yt))?\/videos\/[^/]+\/markups$/, '$1/videos/#id/markups'],
        [/^(\/(rt|yt))?\/votes\/\d+\/delete$/, '$1/votes/#id/delete'],
        [/^(\/(rt|yt))?\/votes\/user\/\d+\/update-rating$/, '$1/votes/user/#internal_user_id/update-rating'],
    ],
});
app.use(metricsMiddleware);

app.get('/metrics', async (req, res, next) => {
    try {
        res.set('Content-Type', promClient.register.contentType);
        res.end(await promClient.register.metrics());
    } catch (err) {
        next(err);
    }
});

app.set('trust proxy', true);

app.use(function (req, res, next) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type, Accept');
    next();
});

const apiSpec = yaml.load(fs.readFileSync('./api/doc/openapi.yaml', 'utf8'));
app.use('/api/doc', (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="API Docs"');
        return res.status(401).send('Unauthorized');
    }
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user !== 'admin' || pass !== process.env.AUTH_TOKEN) {
        res.setHeader('WWW-Authenticate', 'Basic realm="API Docs"');
        return res.status(401).send('Unauthorized');
    }
    next();
}, swaggerUi.serve, swaggerUi.setup(apiSpec));

app.use('/', routes);
app.use('/', require('./prv'));
app.use('/rt', require('./rt'));
app.use('/yt', require('./yt'));

app.use((error, req, res, next) => {
    // redactRequest strips AUTH_TOKEN (Authorization header, verifyBearerToken
    // in query and url) so a failing admin request never logs it.
    console.error('Error: ', { ...redactRequest(req), error });
    res.status(500).send('Internal Server Error');
});

// Block listen() until schema sync + idempotent ALTERs + category seeding all
// finish. Otherwise Express would accept traffic against a half-migrated DB
// (e.g. requests touching users.banned_at would fail with `column does not
// exist` for the brief window between listen() and the ALTER completing).
bootstrap().then(() => {
    registerCalculatorHeartbeat(sequelize);
    app.listen(port, () => {
        console.log(`I am alive, http://localhost:${port}`);
    });
}).catch(err => {
    console.error('Bootstrap failed; refusing to start HTTP server:', err);
    process.exit(1);
});
