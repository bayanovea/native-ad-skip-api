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

        async getIdsBySegmentData(video, categoryId, start, end) {
            const videoCalculated = await models.VideoCalculated.findOne({
                where: { video_id: String(video.id) },
            });
            if (!videoCalculated) throw new Error('Video calculated not found');

            let markupIds = [];
            for (let i = 0; i < videoCalculated.data.length; i++) {
                const interval = videoCalculated.data[i];
                if (interval.category_id === categoryId && interval.start === start && interval.end === end) {
                    const metaSegment = videoCalculated.meta.segments[i];
                    if (metaSegment.id !== i) throw new Error('Segment id should match iterator');
                    markupIds.push(...metaSegment.markup_ids);
                }
            }
            markupIds = [...new Set(markupIds)];
            if (markupIds.length === 0) throw new Error('Empty markup ids');
            return markupIds;
        },

        async softDeleteByIds(markupIds, userId, prvUserId) {
            const updateValues = {
                deleted_at: Date.now(),
                deleted_by_user_id: userId,
                deleted_by_prv_user_id: prvUserId,
            };

            await sequelize.transaction(async (transaction) => {
                await models.Markup.update(updateValues, { where: { id: markupIds }, transaction });
                await models.MarkupTimeInterval.update(updateValues, { where: { markup_id: markupIds }, transaction });
            });
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
