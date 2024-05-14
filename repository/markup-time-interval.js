const db = require('../db');

const markupTimeIntervalRepository = {
    async findAll(options, includeDeleted = false) {
        _updateOptionsByDeleted(options, includeDeleted);
        return db.MarkupTimeInterval.findAll(options);
    },
    
    async findOne(options, includeDeleted = false) {
        _updateOptionsByDeleted(options, includeDeleted);
        return db.MarkupTimeInterval.findOne(options);
    },

    _updateOptionsByDeleted: function(options, includeDeleted) {
        if (includeDeleted === false) {
            options.deleted_at = null;
        }
    },
};

module.exports = markupTimeIntervalRepository;