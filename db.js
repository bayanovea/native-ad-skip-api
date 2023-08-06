const { Sequelize, DataTypes } = require('sequelize')

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

/** Models **/

const Markup = db.define("markup", {
    video_id: DataTypes.INTEGER,
    user_id: DataTypes.INTEGER,
    category_id: DataTypes.INTEGER
});

const MarkupCategory = db.define("markup_category", {
    category: DataTypes.ENUM('sponsor', 'subscribe')
});

const MarkupTimeInterval = db.define("markup_time_interval", {
    markup_id: DataTypes.INTEGER,
    start: DataTypes.INTEGER,
    end: DataTypes.INTEGER
});

const Video = db.define("video", {
    native_id: {
        type: DataTypes.STRING,
    },
});

const VideoCalculated = db.define("video_calculated", {
    video_id: DataTypes.INTEGER,
    data: DataTypes.JSON
});

/** Rels **/

Markup.belongsTo(Video, {
    foreignKey: 'video_id',
    as: 'video'
});
Markup.belongsTo(MarkupCategory, {
    foreignKey: 'category_id',
    as: 'category'
});

MarkupCategory.hasMany(Markup, {
    foreignKey: 'category_id',
    as: 'markup'
});

MarkupTimeInterval.belongsTo(Markup, {
    foreignKey: 'markup_id',
    as: 'markup'
});

Video.hasOne(VideoCalculated, {
    foreignKey: 'video_id',
    as: 'calculated'
});
Video.hasMany(Markup, {
    foreignKey: 'video_id',
    as: 'markup'
});

VideoCalculated.belongsTo(Video, {
    foreignKey: 'video_id',
    as: 'video'
});


db.sync().then(() => {
    console.log('Tables schemas synced');
}).catch((error) => {
    console.error('Tables schemas sync error: ', error);
});

// Handle application shutdown
process.on('SIGINT', () => {
    console.log('Stopping the app...');

    db.close().then(() => {
        console.log('DB connection has ended');
        process.exit();
    });
});

module.exports = {
    db,
    Markup,
    MarkupCategory,
    MarkupTimeInterval,
    Video,
    VideoCalculated
};
