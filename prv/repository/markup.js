const { QueryTypes } = require('sequelize');

module.exports = function createMarkupRepository(models, sequelize) {
    const tableName = models.Markup.getTableName();

    return {
        fields: ['id', 'video_id', 'user_id', 'category_id', 'is_new', 'createdAt', 'updatedAt', 'deleted_at',
            'deleted_by_user_id', 'deleted_by_prv_user_id'],

        async findAll(options, includeDeleted = false) {
            this._updateOptionsByDeleted(options, includeDeleted);
            return models.Markup.findAll(options);
        },

        async findByPk(id, includeDeleted = false) {
            const markup = await models.Markup.findByPk(id);
            if (!markup) return null;
            if (includeDeleted === false && markup.deleted_at !== null) return null;
            return markup;
        },

        async findByRequest(req, includeDeleted = false) {
            let query = {
                sql: `SELECT * FROM "${tableName}" m WHERE 1=1`,
                replacements: [],
            };

            query = this._getWhere(req, query);
            query = this._getOrderBy(req, query);

            try {
                return await sequelize.query(query.sql, {
                    replacements: query.replacements,
                    type: QueryTypes.SELECT,
                });
            } catch (error) {
                console.error('Query error:', error);
            }
        },

        async softDeleteByIds(markupIds, userId, prvUserId, { transaction } = {}) {
            const updateValues = {
                deleted_at: Date.now(),
                deleted_by_user_id: userId,
                deleted_by_prv_user_id: prvUserId,
            };

            const run = async (tx) => {
                await models.Markup.update(updateValues, { where: { id: markupIds }, transaction: tx });
                await models.MarkupTimeInterval.update(updateValues, { where: { markup_id: markupIds }, transaction: tx });
            };

            // If the caller already owns a transaction (e.g. /admin/moderation/decide
            // wraps the whole decision flow in one), join it so the soft-delete is
            // atomic with the decision-row insert and sibling-update. Otherwise open
            // our own.
            if (transaction) {
                await run(transaction);
            } else {
                await sequelize.transaction(run);
            }
        },

        _updateOptionsByDeleted(options, includeDeleted) {
            if (includeDeleted === false) options.where.deleted_at = null;
        },

        _getWhere(req, query) {
            this.fields.forEach(field => {
                if (req.query[field]) {
                    query.sql += ` AND ${field} = ?`;
                    query.replacements.push(req.query[field]);
                }
            });
            return query;
        },

        _getOrderBy(req, query) {
            const orderBy = req.query['order_by'];
            if (orderBy) {
                const orderStatements = orderBy.split(',')
                    .map(field => {
                        field = field.trim();
                        const cleanField = field.replace('-', '');
                        if (!this.fields.includes(cleanField)) return null;
                        return field.startsWith('-') ? `"${cleanField}" DESC` : `"${cleanField}" ASC`;
                    })
                    .filter(Boolean);
                if (orderStatements.length) query.sql += ` ORDER BY ${orderStatements.join(', ')}`;
            }
            return query;
        },
    };
};
