require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser')
const db = require('./db');
const routes = require('./routes');

const app = express();
const port = 3000;

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.use('/', routes);

app.listen(port, () => {
    console.log(`I am alive, http://localhost:${port}`);
});
