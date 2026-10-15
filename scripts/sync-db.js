'use strict';

// Creates schema and seeds categories for the DB specified by DB_NAME env var.
// Same steps as app boot (db.js bootstrap() → lib/schema.js): sync() plus the
// idempotent ALTERs for tables that already exist.
// Usage: DB_NAME=mydb [DB_HOST=localhost DB_PORT=5432] node scripts/sync-db.js

const { scriptSequelize } = require('../lib/script-db');
const { syncSchema } = require('../lib/schema');

const sequelize = scriptSequelize();

const prv = require('../prv/db')(sequelize);
const rt = require('../rt/db')(sequelize);
const yt = require('../yt/db')(sequelize);

syncSchema(sequelize, [prv, rt, yt]).then(async () => {
    await sequelize.close();
    process.exit(0);
}).catch(e => {
    console.error('Schema sync failed:', e);
    process.exit(1);
});
