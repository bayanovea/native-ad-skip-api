'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class Markup extends Model {
        static associate(models) {
            Markup.belongsTo(models.Video, {
                foreignKey: 'video_id',
                as: 'video'
            });
            Markup.belongsTo(models.MarkupCategory, {
                foreignKey: 'category_id',
                as: 'category'
            });
        }
    }

    Markup.init({
        video_id: DataTypes.CHAR(20),
        user_id: DataTypes.INTEGER,
        category_id: DataTypes.INTEGER
    }, {
        sequelize,
        modelName: 'Markup',
        tableName: 'markup',
        timestamps: false
    });

    return Markup;
}