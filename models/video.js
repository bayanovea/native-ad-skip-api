'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class Video extends Model {
        static associate(models) {
            Video.hasOne(models.VideoCalculated, {
                foreignKey: 'video_id',
                as: 'calculated'
            });
            Video.hasMany(models.Markup, {
                foreignKey: 'video_id',
                as: 'markup'
            });
        }
    }
    
    Video.init({
        native_id: DataTypes.CHAR(20)
    }, {
        sequelize,
        modelName: 'Video',
        tableName: 'video',
        timestamps: false
    });
    
    return Video;
}