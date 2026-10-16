'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactRequest, redactUrl, REDACTED } = require('../lib/redact-request');

const TOKEN = 's3cr3t-token';

function fakeReq(overrides = {}) {
    return {
        method: 'GET',
        url: `/admin/video/42?verifyBearerToken=${TOKEN}`,
        headers: { host: 'localhost', authorization: `Bearer ${TOKEN}`, accept: 'text/html' },
        body: { video_id: 'abc' },
        params: { video_id: '42' },
        query: { verifyBearerToken: TOKEN },
        ...overrides,
    };
}

test('redactRequest removes the token from header, query and url', () => {
    const out = redactRequest(fakeReq());

    assert.equal(out.headers.authorization, REDACTED);
    assert.equal(out.query.verifyBearerToken, REDACTED);
    assert.equal(out.url, `/admin/video/42?verifyBearerToken=${REDACTED}`);
    assert.ok(!JSON.stringify(out).includes(TOKEN), 'token must not appear anywhere in the log object');
});

test('redactRequest keeps every other field as is', () => {
    const req = fakeReq({ query: { verifyBearerToken: TOKEN, show: 'all' } });
    const out = redactRequest(req);

    assert.equal(out.method, 'GET');
    assert.equal(out.headers.host, 'localhost');
    assert.equal(out.headers.accept, 'text/html');
    assert.equal(out.query.show, 'all');
    assert.deepEqual(out.body, { video_id: 'abc' });
    assert.deepEqual(out.params, { video_id: '42' });
});

test('redactRequest does not mutate the request', () => {
    const req = fakeReq();
    redactRequest(req);

    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.query.verifyBearerToken, TOKEN);
    assert.equal(req.url, `/admin/video/42?verifyBearerToken=${TOKEN}`);
});

test('redactRequest redacts a Basic authorization header (/api/doc)', () => {
    const basic = `Basic ${Buffer.from(`admin:${TOKEN}`).toString('base64')}`;
    const out = redactRequest(fakeReq({ headers: { authorization: basic } }));
    assert.equal(out.headers.authorization, REDACTED);
});

test('redactRequest leaves requests without a token untouched', () => {
    const req = fakeReq({ url: '/video-calculated?video_id=1', headers: { host: 'x' }, query: { video_id: '1' } });
    const out = redactRequest(req);

    assert.equal(out.url, '/video-calculated?video_id=1');
    assert.deepEqual(out.headers, { host: 'x' });
    assert.ok(!('authorization' in out.headers), 'no authorization header is invented');
    assert.deepEqual(out.query, { video_id: '1' });
});

test('redactRequest copes with missing headers and query', () => {
    const out = redactRequest({ method: 'GET', url: '/' });
    assert.equal(out.url, '/');
    assert.equal(out.headers, undefined);
    assert.equal(out.query, undefined);
});

test('redactRequest redacts a non-string query value (array / object from the query parser)', () => {
    const out = redactRequest(fakeReq({ query: { verifyBearerToken: [TOKEN, 'x'] } }));
    assert.equal(out.query.verifyBearerToken, REDACTED);
});

test('redactUrl redacts the param anywhere in the query string', () => {
    assert.equal(
        redactUrl(`/admin/moderation?show=all&verifyBearerToken=${TOKEN}&format=json`),
        `/admin/moderation?show=all&verifyBearerToken=${REDACTED}&format=json`
    );
    assert.equal(
        redactUrl(`/admin/review/b1?verifyBearerToken=${encodeURIComponent('a&b=c')}`),
        `/admin/review/b1?verifyBearerToken=${REDACTED}`
    );
});

test('redactUrl redacts every occurrence of the param', () => {
    assert.equal(
        redactUrl(`/x?verifyBearerToken=${TOKEN}&verifyBearerToken=${TOKEN}`),
        `/x?verifyBearerToken=${REDACTED}&verifyBearerToken=${REDACTED}`
    );
});

test('redactUrl matches encoded and bracketed keys the query parser accepts', () => {
    assert.equal(redactUrl(`/x?verify%42earerToken=${TOKEN}`), `/x?verify%42earerToken=${REDACTED}`);
    assert.equal(redactUrl(`/x?verifyBearerToken[]=${TOKEN}`), `/x?verifyBearerToken[]=${REDACTED}`);
    assert.equal(redactUrl(`/x?verifyBearerToken%5B0%5D=${TOKEN}`), `/x?verifyBearerToken%5B0%5D=${REDACTED}`);
});

test('redactUrl leaves similar keys, paths and malformed escapes alone', () => {
    assert.equal(redactUrl('/x?verifyBearerTokenX=1&notverifyBearerToken=2'), '/x?verifyBearerTokenX=1&notverifyBearerToken=2');
    assert.equal(redactUrl('/verifyBearerToken=1'), '/verifyBearerToken=1');
    assert.equal(redactUrl('/x?bad=%E0%A4%A&y=1'), '/x?bad=%E0%A4%A&y=1');
    assert.equal(redactUrl('/x?verifyBearerToken'), `/x?verifyBearerToken=${REDACTED}`);
    assert.equal(redactUrl(undefined), undefined);
});
