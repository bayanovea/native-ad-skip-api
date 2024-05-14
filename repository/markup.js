const db = require('../db');

const markupRepository = {
    fields: ['id', 'video_id', 'user_id', 'category_id', 'is_new', 'createdAt', 'updatedAt', 'deleted_at', 'deleted_by_user_id', 
        'deleted_by_vk_user_id'],

    async findAll(options, includeDeleted = false) {
        _updateOptionsByDeleted(options, includeDeleted);
        return db.Markup.findAll(options);
    },

    async findByPk(id, includeDeleted = false) {
        _updateOptionsByDeleted(options, includeDeleted);
        return db.Markup.findByPk(id);
    },

    /**
     * All supported fields see in this.fields
     * 
     * req.field_name is filter by field
     * req.order_by format is "field1, field2, -field3, -field4". Minus means DESC.
     */
    async findByRequest(req, includeDeleted = false) {
        _updateOptionsByDeleted(req, includeDeleted);

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

    _updateOptionsByDeleted: function(options, includeDeleted) {
        if (includeDeleted === false) {
            options.deleted_at = null;
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

module.exports = markupRepository;