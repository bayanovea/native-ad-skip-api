module.exports = function createMarkupTimeIntervalRepository(models) {
    return {
        async findAll(options, includeDeleted = false) {
            this._updateOptionsByDeleted(options, includeDeleted);
            return models.MarkupTimeInterval.findAll(options);
        },

        async findOne(options, includeDeleted = false) {
            this._updateOptionsByDeleted(options, includeDeleted);
            return models.MarkupTimeInterval.findOne(options);
        },

        _updateOptionsByDeleted(options, includeDeleted) {
            if (includeDeleted === false) options.where = { ...options.where, deleted_at: null };
        },
    };
};
