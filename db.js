const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
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
// represented by a Sequelize migration), and category seeding. server.js MUST
// await this before calling app.listen() so the app does not accept traffic
// against a half-migrated schema (e.g. requests touching users.banned_at would
// otherwise fail with `column does not exist` until the ALTER finishes).
async function bootstrap() {
    await sequelize.sync();
    console.log('Tables schemas synced');
    await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP NULL');
    for (const { MarkupCategory } of [prv, rt, yt]) {
        const categories = await MarkupCategory.findAll();
        if (!categories.length) {
            await MarkupCategory.create({ category: 'intro' });
            await MarkupCategory.create({ category: 'sponsor' });
            await MarkupCategory.create({ category: 'self_promotion' });
            await MarkupCategory.create({ category: 'credits' });
        }
    }
}

module.exports = { sequelize, prv, rt, yt, bootstrap };
