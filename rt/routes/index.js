const { rt } = require('../../db');

module.exports = require('../../prv/routes/provider-router')(rt, 'rt');
