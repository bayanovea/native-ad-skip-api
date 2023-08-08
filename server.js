const path = require('path')
require('dotenv').config({
    path: path.join(__dirname, process.env.NODE_ENV === 'production' ? '.env.production' : '.env')
    // path: __dirname + process.env.NODE_ENV === 'production' ? '/.env.production' : '/.env'
});

const express = require('express');
const bodyParser = require('body-parser')
const db = require('./db');
const routes = require('./routes');

const app = express();
const port = process.env.PORT;

// body parser
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// session
app.set('trust proxy', true)

// cors
app.use(function (req, res, next) {
    const origin = req.headers.origin || '*'
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type, Accept')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    next()
})

// routes
app.use('/', routes);

app.listen(port, () => {
    console.log(`I am alive, http://localhost:${port}`);
});
