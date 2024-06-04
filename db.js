const { Sequelize, DataTypes } = require('sequelize')

const db = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'postgres',
    logging: false
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
    user_id: DataTypes.CHAR(36),
    prv_user_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    category_id: DataTypes.INTEGER,
    is_new: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    deleted_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    deleted_by_user_id: {
        type: DataTypes.CHAR(36),
        allowNull: true
    },
    deleted_by_prv_user_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
});

const MarkupCategory = db.define("markup_category", {
    category: DataTypes.ENUM('intro', 'sponsor', 'self_promotion', 'credits')
});

const MarkupTimeInterval = db.define("markup_time_interval", {
    markup_id: DataTypes.INTEGER,
    start: DataTypes.FLOAT,
    end: DataTypes.FLOAT,
    deleted_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    deleted_by_user_id: {
        type: DataTypes.CHAR(36),
        allowNull: true
    },
    deleted_by_prv_user_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
});

const Video = db.define("video", {
    native_id: {
        type: DataTypes.STRING,
    },
});

const VideoCalculated = db.define("video_calculated", {
    video_id: DataTypes.INTEGER,
    data: DataTypes.JSON,
    meta: DataTypes.JSON
});

const Vote = db.define("vote", {
    user_id: DataTypes.CHAR(36),
    prv_user_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    video_id: DataTypes.INTEGER,
    category_id: DataTypes.INTEGER,
    start: DataTypes.FLOAT,
    end: DataTypes.FLOAT,
    vote: DataTypes.SMALLINT
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

Vote.belongsTo(Video, {
    foreignKey: 'video_id',
    as: 'video'
});
Vote.belongsTo(MarkupCategory, {
    foreignKey: 'category_id',
    as: 'category'
});


/**
 * Миграция, создаёт категории
 * @returns {Promise<void>}
 */
const migrateCategories = async () => {
    await MarkupCategory.create({ category: 'intro' })
    await MarkupCategory.create({ category: 'sponsor' })
    await MarkupCategory.create({ category: 'self_promotion' })
    await MarkupCategory.create({ category: 'credits' })
}

db.sync().then(async () => {
    console.log('Tables schemas synced');
    const categories = await MarkupCategory.findAll()
    if (!categories.length) {
        migrateCategories()
    }
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
    // Models
    Markup,
    MarkupCategory,
    MarkupTimeInterval,
    Video,
    VideoCalculated,
    Vote,
};
