import { Sequelize } from 'sequelize';

const db = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'postgres'
});

// Test the connection
db.authenticate()
    .catch(err => {
        console.error('Unable to connect to the database:', err);
        process.exit(-1);
    });

// Handle application shutdown
process.on('SIGINT', () => {
    console.log('Stopping the app...');

    db.close().then(() => {
        console.log('DB connection has ended');
        process.exit();
    });
});

module.exports = db;
