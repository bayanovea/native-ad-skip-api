'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// PROVIDER_LINK_AT is read once on require, so each template loads in its own process.
function link(template, nativeId, seconds) {
    const r = spawnSync(process.execPath,
        ['-e', `process.stdout.write(require(${JSON.stringify(path.join(__dirname, '../lib/player-link'))}).linkAt(${JSON.stringify(nativeId)}, ${seconds}))`],
        { env: { ...process.env, PROVIDER_LINK_AT: template }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

test('linkAt: PROVIDER_LINK_AT fills {id} and {t}; unset or empty is the placeholder URL', () => {
    assert.equal(link('https://p.example/w/{id}#t={t}', '-1_2', 3661), 'https://p.example/w/-1_2#t=1h1m1s');
    assert.equal(link('https://p.example/{id}/{t}/{id}', '-1_2', 59), 'https://p.example/-1_2/59s/-1_2');
    assert.equal(link('https://p.example/{t}', '-1_2', -5), 'https://p.example/0s');
    assert.equal(link('', '-1_2', 125), 'https://example.invalid/video-1_2?t=2m5s');
});
