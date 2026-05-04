'use strict';

// Creates schema and seeds categories for the DB specified by DB_NAME env var.
// Usage: DB_NAME=mydb node scripts/sync-db.js

const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
        host: process.env.DB_HOST || 'localhost',
        dialect: 'postgres',
        logging: false,
        dialectOptions: { connectTimeout: 10000 },
    }
);

const prv = require('../prv/db')(sequelize);
const rt = require('../rt/db')(sequelize);
const yt = require('../yt/db')(sequelize);

sequelize.sync().then(async () => {
    for (const { MarkupCategory } of [prv, rt, yt]) {
        const cats = await MarkupCategory.findAll();
        if (!cats.length) {
            await MarkupCategory.bulkCreate([
                { category: 'intro' },
                { category: 'sponsor' },
                { category: 'self_promotion' },
                { category: 'credits' },
            ]);
        }
    }
    await sequelize.close();
    process.exit(0);
}).catch(e => {
    console.error('Schema sync failed:', e);
    process.exit(1);
});
