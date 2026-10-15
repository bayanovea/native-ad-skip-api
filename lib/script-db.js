'use strict';

// Sequelize instance for one-off scripts (scripts/sync-db.js,
// scripts/import-review-sheet.js) from DB_NAME / DB_USER / DB_PASSWORD /
// DB_HOST (default localhost) / DB_PORT (default 5432). The app itself
// connects in db.js with the same DB_PORT rule.
const { Sequelize } = require('sequelize');

function scriptSequelize() {
    return new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        dialect: 'postgres',
        logging: false,
        dialectOptions: { connectTimeout: 10000 },
    });
}

module.exports = { scriptSequelize };
