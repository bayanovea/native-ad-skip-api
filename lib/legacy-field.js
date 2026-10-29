'use strict';

// Clients may still send the user id field under its earlier name (LEGACY_PRV, the
// earlier prefix of the DB objects, renamed on boot by lib/schema.js). Mounted
// before every provider router, so the validators see `prv_user_id` as before.
const LEGACY_PRV = process.env.LEGACY_PRV || null;

function legacyField(legacy = LEGACY_PRV) {
    if (!legacy) return (req, res, next) => next();
    const field = `${legacy}_user_id`;
    const alias = (o) => {
        if (o && typeof o === 'object' && field in o && o.prv_user_id === undefined) o.prv_user_id = o[field];
    };
    return (req, res, next) => {
        alias(req.query);
        if (Array.isArray(req.body)) req.body.forEach(alias); else alias(req.body);
        next();
    };
}

module.exports = { legacyField, LEGACY_PRV };
