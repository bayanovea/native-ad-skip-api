'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class MarkupTimeInterval extends Model {
        static associate(models) {
            MarkupTimeInterval.belongsTo(models.Markup, {
                foreignKey: 'markup_id',
                as: 'markup'
            });
        }
    }

    MarkupTimeInterval.init({
        markup_id: DataTypes.INTEGER,
        start: DataTypes.INTEGER,
        end: DataTypes.INTEGER
    }, {
        sequelize,
        modelName: 'MarkupTimeInterval',
        tableName: 'markup_time_interval',
        timestamps: false
    });

    return MarkupTimeInterval;
}