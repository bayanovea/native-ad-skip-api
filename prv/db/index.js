const { DataTypes } = require('sequelize');

module.exports = function(sequelize) {
    const Markup = sequelize.define('markup', {
        video_id: DataTypes.INTEGER,
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        category_id: DataTypes.INTEGER,
        is_new: { type: DataTypes.BOOLEAN, defaultValue: true },
        deleted_at: { type: DataTypes.DATE, allowNull: true },
        deleted_by_user_id: { type: DataTypes.CHAR(36), allowNull: true },
        deleted_by_prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        internal_user_id: { type: DataTypes.INTEGER, allowNull: true },
    }, { tableName: 'markups' });

    const MarkupCategory = sequelize.define('markup_category', {
        category: DataTypes.ENUM('intro', 'sponsor', 'self_promotion', 'credits'),
    }, { tableName: 'markup_categories' });

    const MarkupTimeInterval = sequelize.define('markup_time_interval', {
        markup_id: DataTypes.INTEGER,
        start: DataTypes.FLOAT,
        end: DataTypes.FLOAT,
        deleted_at: { type: DataTypes.DATE, allowNull: true },
        deleted_by_user_id: { type: DataTypes.CHAR(36), allowNull: true },
        deleted_by_prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        deleted_by_internal_user_id: { type: DataTypes.INTEGER, allowNull: true },
    }, { tableName: 'markup_time_intervals' });

    const Video = sequelize.define('video', {
        native_id: { type: DataTypes.STRING },
        duration: { type: DataTypes.INTEGER, allowNull: true },
        duration_status: { type: DataTypes.SMALLINT, allowNull: true },
    }, { tableName: 'videos' });

    const VideoCalculated = sequelize.define('video_calculated', {
        video_id: DataTypes.INTEGER,
        data: DataTypes.JSON,
        meta: DataTypes.JSON,
    }, { tableName: 'video_calculateds' });

    const Vote = sequelize.define('vote', {
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        video_id: DataTypes.INTEGER,
        category_id: DataTypes.INTEGER,
        start: DataTypes.FLOAT,
        end: DataTypes.FLOAT,
        vote: DataTypes.SMALLINT,
    }, { tableName: 'votes' });

    const User = sequelize.define('user', {
        generated_user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        rating: { type: DataTypes.INTEGER, defaultValue: 0 },
        time_saved: { type: DataTypes.INTEGER, defaultValue: 0 },
    }, {
        tableName: 'users',
        indexes: [{ unique: true, fields: ['generated_user_id', 'prv_user_id'] }],
    });

    const DurationLog = sequelize.define('duration_log', {
        user_id: DataTypes.INTEGER,
        video_id: DataTypes.INTEGER,
        duration: { type: DataTypes.INTEGER, allowNull: false },
        count: { type: DataTypes.SMALLINT, allowNull: false },
    }, { tableName: 'duration_logs' });

    const IntervalUndo = sequelize.define('interval_undo', {
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        video_native_id: DataTypes.STRING,
        category_id: DataTypes.INTEGER,
        start: DataTypes.INTEGER,
        end: DataTypes.INTEGER,
    }, { tableName: 'prv_events_interval_undo' });

    const IntervalClick = sequelize.define('interval_click', {
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        video_native_id: DataTypes.STRING,
        category_id: DataTypes.INTEGER,
        start: DataTypes.INTEGER,
        end: DataTypes.INTEGER,
        click_time: DataTypes.INTEGER,
    }, { tableName: 'prv_events_interval_click' });

    const TimeSavedEvent = sequelize.define('time_saved_event', {
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        inc: { type: DataTypes.INTEGER, allowNull: true },
    }, { tableName: 'prv_events_time_saved' });

    Markup.belongsTo(Video, { foreignKey: 'video_id', as: 'video' });
    Markup.belongsTo(MarkupCategory, { foreignKey: 'category_id', as: 'category' });
    Markup.belongsTo(User, { foreignKey: 'internal_user_id', as: 'user' });
    MarkupCategory.hasMany(Markup, { foreignKey: 'category_id', as: 'markup' });
    MarkupTimeInterval.belongsTo(Markup, { foreignKey: 'markup_id', as: 'markup' });
    MarkupTimeInterval.belongsTo(User, { foreignKey: 'deleted_by_internal_user_id', as: 'deleted_by_user' });
    Video.hasOne(VideoCalculated, { foreignKey: 'video_id', as: 'calculated' });
    Video.hasMany(Markup, { foreignKey: 'video_id', as: 'markup' });
    VideoCalculated.belongsTo(Video, { foreignKey: 'video_id', as: 'video' });
    Vote.belongsTo(Video, { foreignKey: 'video_id', as: 'video' });
    Vote.belongsTo(MarkupCategory, { foreignKey: 'category_id', as: 'category' });
    DurationLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
    DurationLog.belongsTo(Video, { foreignKey: 'video_id', as: 'video' });

    return { Markup, MarkupCategory, MarkupTimeInterval, Video, VideoCalculated, Vote, User, DurationLog, IntervalUndo, IntervalClick, TimeSavedEvent };
};
