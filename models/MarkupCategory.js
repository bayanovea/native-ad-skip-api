'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class MarkupCategory extends Model {
        static associate(models) {
            MarkupCategory.hasMany(models.Markup, {
                foreignKey: 'category_id',
                as: 'markup'
            });
        }
    }
    
    MarkupCategory.init({
        category: DataTypes.ENUM('sponsor', 'subscribe')
    }, {
        sequelize,
        modelName: 'MarkupCategory',
        tableName: 'markup_category',
        timestamps: false
    });
    
    return MarkupCategory;
}