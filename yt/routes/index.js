const { yt } = require('../../db');

module.exports = require('../../prv/routes/provider-router')(yt, 'yt');
