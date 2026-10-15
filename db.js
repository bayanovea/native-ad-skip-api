const { Sequelize } = require('sequelize');
const { syncSchema } = require('./lib/schema');

// DB_PORT is optional (default 5432, what prod uses); set it to reach a local
// Postgres on another port, e.g. the restored prod dump on 5433. Same rule as
// lib/script-db.js (the connection for scripts/).
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    dialect: 'postgres',
    logging: false,
    dialectOptions: { connectTimeout: 60000 },
});

sequelize.authenticate().catch(err => {
    console.error('Unable to connect to the database:', err);
    process.exit(-1);
});

process.on('SIGINT', () => {
    console.log('Stopping the app...');
    sequelize.close().then(() => {
        console.log('DB connection has ended');
        process.exit();
    });
});

const prv = require('./prv/db')(sequelize);
const rt = require('./rt/db')(sequelize);
const yt = require('./yt/db')(sequelize);

// bootstrap() performs schema sync, idempotent ALTERs (for columns not yet
// represented by a Sequelize migration), and category seeding — see
// lib/schema.js, shared with scripts/sync-db.js. server.js MUST await this
// before calling app.listen() so the app does not accept traffic against a
// half-migrated schema (e.g. requests touching users.banned_at would otherwise
// fail with `column does not exist` until the ALTER finishes).
async function bootstrap() {
    await syncSchema(sequelize, [prv, rt, yt]);
    console.log('Tables schemas synced');
}

module.exports = { sequelize, prv, rt, yt, bootstrap };
