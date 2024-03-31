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
    category_id: DataTypes.INTEGER,
    is_new: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

const MarkupCategory = db.define("markup_category", {
    category: DataTypes.ENUM('intro', 'sponsor', 'self_promotion', 'credits')
});

const MarkupTimeInterval = db.define("markup_time_interval", {
    markup_id: DataTypes.INTEGER,
    start: DataTypes.FLOAT,
    end: DataTypes.FLOAT
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
    video_id: DataTypes.INTEGER,
    video_calculated_segment_id: DataTypes.INTEGER,
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

/** 
 * Repositories 
 * 
 * TODO: Move to separate file
 **/

const MarkupRepository = {
    fields: ['id', 'video_id', 'user_id', 'category_id', 'is_new', 'createdAt', 'updatedAt'],

    /**
     * All supported fields see in this.fields
     * 
     * req.field_name is filter by field
     * req.order_by format is "field1, field2, -field3, -field4". Minus means DESC.
     */
    findByRequest: async function(req) {
        let query = {
            sql: `
                SELECT * FROM markups m 
                WHERE 1=1
            `,
            replacements: []
        };

        query = this._getWhere(req, query);
        query = this._getOrderBy(req, query);

        try {
            const markups = await db.query(query.sql, {
                replacements: query.replacements,
                type: db.QueryTypes.SELECT
            });
            return markups;
        } catch (error) {
            console.error("Ошибка выполнения запроса:", error);
        }
    },

    _getWhere: function(req, query) {
        this.fields.forEach(field => {
            if (req.query[field]) {
                query.sql += ` AND ${field} = ?`;
                query.replacements.push(req.query[field]);
            }
        });

        return query;
    },

    _getOrderBy: function(req, query) {
        let orderBy = req.query['order_by'];

        if (orderBy) {
            let orderFields = orderBy.split(',');

            let orderStatements = orderFields.map(field => {
                field = field.trim();
                if (this.fields.includes(field.replace('-', ''))) {
                    if (field.includes('-')) {
                        field = field.replace('-', '');
                        return `"${field}" DESC`;
                    } else {
                        return `"${field}" ASC`;
                    }
                }
            }).filter(Boolean); // remove any undefined values

            if (orderStatements.length) {
                query.sql += ` ORDER BY ${orderStatements.join(', ')}`;
            }
        }

        return query;
    },
};


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
    // Repositories
    MarkupRepository
};
