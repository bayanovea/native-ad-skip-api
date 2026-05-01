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

sequelize.sync().then(async () => {
    console.log('Tables schemas synced');
    for (const { MarkupCategory } of [prv, rt, yt]) {
        const categories = await MarkupCategory.findAll();
        if (!categories.length) {
            await MarkupCategory.create({ category: 'intro' });
            await MarkupCategory.create({ category: 'sponsor' });
            await MarkupCategory.create({ category: 'self_promotion' });
            await MarkupCategory.create({ category: 'credits' });
        }
    }
}).catch(err => console.error('Tables schemas sync error:', err));

module.exports = { sequelize, prv, rt, yt };
