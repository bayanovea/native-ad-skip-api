'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const client = require('prom-client');

// Reset the default registry between tests so counters start at 0. The wrapper
// module registers its counters on require, so reload it after clearing.
beforeEach(() => {
    client.register.clear();
    delete require.cache[require.resolve('../prometheus-wrapper.js')];
});

async function counterValue(name, labels) {
    const metric = client.register.getSingleMetric(name);
    assert.ok(metric, `metric ${name} should be registered`);
    const json = await metric.get();
    const entry = json.values.find(v =>
        Object.entries(labels).every(([k, val]) => v.labels[k] === val)
    );
    return entry ? entry.value : 0;
}

test('incrementVideoCalculatedLookup increments by outcome and provider', async () => {
    const wrapper = require('../prometheus-wrapper.js');

    wrapper.incrementVideoCalculatedLookup('match', 'prv');
    wrapper.incrementVideoCalculatedLookup('match', 'prv');
    wrapper.incrementVideoCalculatedLookup('not_found', 'rt');

    assert.equal(await counterValue('video_calculated_lookup_total', { outcome: 'match', provider: 'prv' }), 2);
    assert.equal(await counterValue('video_calculated_lookup_total', { outcome: 'not_found', provider: 'rt' }), 1);
    assert.equal(await counterValue('video_calculated_lookup_total', { outcome: 'mismatch', provider: 'yt' }), 0);
});

test('incrementRequestWithoutVersion increments by method and provider', async () => {
    const wrapper = require('../prometheus-wrapper.js');

    wrapper.incrementRequestWithoutVersion('POST /markup', 'prv');
    wrapper.incrementRequestWithoutVersion('GET /video-calculated', 'prv');
    wrapper.incrementRequestWithoutVersion('POST /markup', 'prv');

    assert.equal(await counterValue('request_without_version_total', { method: 'POST /markup', provider: 'prv' }), 2);
    assert.equal(await counterValue('request_without_version_total', { method: 'GET /video-calculated', provider: 'prv' }), 1);
});

test('counters are exposed via prom-client default register output', async () => {
    const wrapper = require('../prometheus-wrapper.js');
    wrapper.incrementVideoCalculatedLookup('backfilled', 'yt');

    const output = await client.register.metrics();
    assert.match(output, /video_calculated_lookup_total\{[^}]*outcome="backfilled"[^}]*provider="yt"[^}]*\} 1/);
    assert.match(output, /request_without_version_total/);
});
