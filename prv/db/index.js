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
    }, { tableName: 'videos' });

    const VideoCalculated = sequelize.define('video_calculated', {
        video_id: DataTypes.INTEGER,
        data: DataTypes.JSON,
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
        banned_at: { type: DataTypes.DATE, allowNull: true },
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

    const CalculatedSegment = sequelize.define('calculated_segment', {
        video_id: DataTypes.INTEGER,
        category_id: DataTypes.INTEGER,
        start: DataTypes.INTEGER,
        end: DataTypes.INTEGER,
        rating: { type: DataTypes.INTEGER, defaultValue: 0 },
    }, { tableName: 'prv_calculated_segments' });

    const CalculatedSegmentMarkup = sequelize.define('calculated_segment_markup', {
        segment_id: DataTypes.INTEGER,
        markup_id: DataTypes.INTEGER,
    }, { tableName: 'prv_calculated_segment_markups' });

    CalculatedSegment.belongsTo(Video, { foreignKey: 'video_id', as: 'video' });
    CalculatedSegment.belongsTo(MarkupCategory, { foreignKey: 'category_id', as: 'category' });
    CalculatedSegment.hasMany(CalculatedSegmentMarkup, { foreignKey: 'segment_id', as: 'segment_markups' });
    CalculatedSegmentMarkup.belongsTo(CalculatedSegment, { foreignKey: 'segment_id', as: 'segment' });

    const ClientFailed = sequelize.define('client_failed', {
        user_id: DataTypes.CHAR(36),
        prv_user_id: { type: DataTypes.INTEGER, allowNull: true },
        video_native_id: DataTypes.STRING,
        reason: DataTypes.STRING,
        data: { type: DataTypes.JSON, allowNull: true },
    }, { tableName: 'prv_events_client_failed' });

    const AdminDecision = sequelize.define('admin_decision', {
        target_type: { type: DataTypes.STRING(16), allowNull: false },
        target_id: { type: DataTypes.INTEGER, allowNull: false },
        decision: { type: DataTypes.STRING(16), allowNull: false },
        signals_snapshot: { type: DataTypes.JSONB, allowNull: true },
        decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        decided_by: { type: DataTypes.STRING(16), allowNull: false },
    }, {
        tableName: 'prv_admin_decisions',
        timestamps: false,
        indexes: [{ fields: [{ name: 'target_type' }, { name: 'target_id' }, { name: 'decided_at', order: 'DESC' }] }],
    });

    // Assessor review (prv only, like AdminDecision). Items come from imported
    // review sheets; verdicts are append-only and the latest row per item wins.
    // `flagged_by` is blind: it must not be shown until the item has a verdict.
    // Timestamps default on the DB side (DB clock, also for raw-SQL inserts);
    // db.js bootstrap() sets the same default on tables created before that.
    const ReviewItem = sequelize.define('review_item', {
        batch: { type: DataTypes.STRING(64), allowNull: false },
        // Sheet the item came from (batch = its part); null on rows of an older image, read as COALESCE(sheet, batch).
        sheet: { type: DataTypes.STRING(64), allowNull: true },
        item_code: { type: DataTypes.STRING(16), allowNull: false },
        position: { type: DataTypes.INTEGER, allowNull: false },
        native_id: { type: DataTypes.STRING(64), allowNull: false },
        start: { type: DataTypes.FLOAT, allowNull: false },
        end: { type: DataTypes.FLOAT, allowNull: false },
        proposed: { type: DataTypes.STRING(64), allowNull: false },
        cues: { type: DataTypes.TEXT, allowNull: true },
        link: { type: DataTypes.TEXT, allowNull: true },
        flagged_by: { type: DataTypes.JSONB, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
    }, {
        tableName: 'prv_review_items',
        timestamps: false,
        indexes: [{ unique: true, fields: ['batch', 'item_code'] }],
    });

    const ReviewVerdict = sequelize.define('review_verdict', {
        item_id: { type: DataTypes.INTEGER, allowNull: false },
        verdict: { type: DataTypes.STRING(16), allowNull: false },
        comment: { type: DataTypes.TEXT, allowNull: true },
        reviewer: { type: DataTypes.STRING(64), allowNull: false },
        source: { type: DataTypes.STRING(16), allowNull: false },
        decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
    }, {
        tableName: 'prv_review_verdicts',
        timestamps: false,
        indexes: [{ fields: [{ name: 'item_id' }, { name: 'decided_at', order: 'DESC' }] }],
    });

    ReviewItem.hasMany(ReviewVerdict, { foreignKey: 'item_id', as: 'verdicts' });
    ReviewVerdict.belongsTo(ReviewItem, { foreignKey: 'item_id', as: 'item' });

    // Who may review: the page makes the reviewer pick a code from this table
    // and every verdict / flag carries it. Seeded in lib/schema.js.
    const ReviewReviewer = sequelize.define('review_reviewer', {
        code: { type: DataTypes.STRING(64), primaryKey: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
    }, { tableName: 'prv_review_reviewers', timestamps: false });

    // One row per batch: how many reviewers must finish it, who may never take
    // it, and its current holder (first come; see prv/repository/review.js).
    // Items reference the batch by name.
    const ReviewBatch = sequelize.define('review_batch', {
        batch: { type: DataTypes.STRING(64), primaryKey: true },
        reviews_needed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        excluded: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        locked_by: { type: DataTypes.STRING(64), allowNull: true },
        locked_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
    }, { tableName: 'prv_review_batches', timestamps: false });

    // Video-level facts a reviewer records next to a verdict (today only
    // `track_mismatch`: the subtitle track does not match the player).
    // Append-only, latest row per (native_id, flag) wins, like verdicts.
    const ReviewVideoFlag = sequelize.define('review_video_flag', {
        native_id: { type: DataTypes.STRING(64), allowNull: false },
        flag: { type: DataTypes.STRING(32), allowNull: false },
        value: { type: DataTypes.BOOLEAN, allowNull: false },
        reviewer: { type: DataTypes.STRING(64), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
    }, {
        tableName: 'prv_review_video_flags',
        timestamps: false,
        indexes: [{ fields: [{ name: 'native_id' }, { name: 'flag' }, { name: 'created_at', order: 'DESC' }] }],
    });

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

    return { Markup, MarkupCategory, MarkupTimeInterval, Video, VideoCalculated, Vote, User, DurationLog, IntervalUndo, IntervalClick, TimeSavedEvent, ClientFailed, CalculatedSegment, CalculatedSegmentMarkup, AdminDecision, ReviewItem, ReviewVerdict, ReviewReviewer, ReviewBatch, ReviewVideoFlag };
};
