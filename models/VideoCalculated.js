'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class VideoCalculated extends Model {
        static associate(models) {
            VideoCalculated.belongsTo(models.Video, {
                foreignKey: 'video_id',
                as: 'video'
            });
        }
    }
    
    VideoCalculated.init({
        video_id: DataTypes.CHAR(20),
        data: DataTypes.JSON
    }, {
        sequelize,
        modelName: 'VideoCalculated',
        tableName: 'video_calculated',
        timestamps: false
    });
    
    return VideoCalculated;
}