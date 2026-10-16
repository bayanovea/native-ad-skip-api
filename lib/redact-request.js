'use strict';

// Request fields for the global error log in server.js, with AUTH_TOKEN taken
// out. The token reaches a request in three places: the Authorization header
// (Bearer for admin routes, Basic for /api/doc), the `verifyBearerToken` query
// param of the admin pages, and the raw query string in req.url.

const REDACTED = '[redacted]';
const TOKEN_PARAM = 'verifyBearerToken';

function safeDecode(value) {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (_) {
        return value;
    }
}

// Compare decoded keys, so `verify%42earerToken=` or `verifyBearerToken[]=`
// (which the query parser also turns into req.query.verifyBearerToken) are
// caught too.
function isTokenKey(rawKey) {
    const key = safeDecode(rawKey);
    return key === TOKEN_PARAM || key.startsWith(`${TOKEN_PARAM}[`);
}

function redactUrl(url) {
    if (typeof url !== 'string') return url;
    const q = url.indexOf('?');
    if (q === -1) return url;
    const params = url.slice(q + 1).split('&').map(part => {
        const eq = part.indexOf('=');
        const key = eq === -1 ? part : part.slice(0, eq);
        return isTokenKey(key) ? `${key}=${REDACTED}` : part;
    });
    return `${url.slice(0, q + 1)}${params.join('&')}`;
}

function redactHeaders(headers) {
    if (!headers || headers.authorization == null) return headers;
    return { ...headers, authorization: REDACTED };
}

function redactQuery(query) {
    if (!query || typeof query !== 'object' || !(TOKEN_PARAM in query)) return query;
    return { ...query, [TOKEN_PARAM]: REDACTED };
}

function redactRequest(req) {
    return {
        method: req.method,
        url: redactUrl(req.url),
        headers: redactHeaders(req.headers),
        body: req.body,
        params: req.params,
        query: redactQuery(req.query),
    };
}

module.exports = { redactRequest, redactUrl, REDACTED };
