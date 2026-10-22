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

test('incrementVideoCalculatedLookup labels the served table: human by default, ai when given', async () => {
    const wrapper = require('../prometheus-wrapper.js');

    wrapper.incrementVideoCalculatedLookup('match', 'prv');
    wrapper.incrementVideoCalculatedLookup('match', 'prv', 'ai');
    wrapper.incrementVideoCalculatedLookup('match', 'prv', 'ai');

    assert.equal(await counterValue('video_calculated_lookup_total', { outcome: 'match', provider: 'prv', source: 'human' }), 1);
    assert.equal(await counterValue('video_calculated_lookup_total', { outcome: 'match', provider: 'prv', source: 'ai' }), 2);
    const output = await client.register.metrics();
    assert.match(output, /video_calculated_lookup_total\{outcome="match",provider="prv",source="ai"\} 2/);
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

function fakeDb(results) {
    const calls = [];
    return {
        calls,
        async query(sql) {
            calls.push(sql);
            const next = results.shift();
            if (next instanceof Error) throw next;
            return [next];
        },
    };
}

test('registerAiMetrics: one query per scrape fills the four AI gauges', async () => {
    const wrapper = require('../prometheus-wrapper.js');
    const db = fakeDb([[
        { metric: 'videos', a: 'published', b: null, value: '3' },
        { metric: 'videos', a: 'seen', b: null, value: '7' },
        { metric: 'cost', a: 'detect', b: null, value: 0.125 },
        { metric: 'cost', a: 'judge', b: null, value: 0 },
        { metric: 'judgements', a: 'review', b: 'llm', value: '2' },
        { metric: 'review_open', a: null, b: null, value: '4' },
    ]]);
    wrapper.registerAiMetrics(db);

    const output = await client.register.metrics();
    assert.equal(db.calls.length, 1, 'the four gauges share one query');
    assert.match(output, /^ai_videos\{status="published"\} 3$/m);
    assert.match(output, /^ai_videos\{status="seen"\} 7$/m);
    assert.match(output, /^ai_cost_usd_total\{kind="detect"\} 0.125$/m);
    assert.match(output, /^ai_cost_usd_total\{kind="judge"\} 0$/m);
    assert.match(output, /^ai_judgements_total\{decision="review",by="llm"\} 2$/m);
    assert.match(output, /^ai_review_open 4$/m);
});

test('registerAiMetrics: a failing query logs once and leaves the gauges empty; a later scrape fills them again', async () => {
    const wrapper = require('../prometheus-wrapper.js');
    const db = fakeDb([
        [{ metric: 'videos', a: 'published', b: null, value: '1' }],
        new Error('relation "prv_ai_videos" does not exist'),
        new Error('relation "prv_ai_videos" does not exist'),
        [{ metric: 'videos', a: 'failed', b: null, value: '2' }],
    ]);
    wrapper.registerAiMetrics(db);
    const logs = [];
    const orig = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
        assert.match(await client.register.metrics(), /^ai_videos\{status="published"\} 1$/m);
        for (let i = 0; i < 2; i++) {
            const output = await client.register.metrics();
            assert.doesNotMatch(output, /^ai_videos\{/m, 'no stale series after a failure');
            assert.doesNotMatch(output, /^ai_judgements_total\{/m);
        }
        const output = await client.register.metrics();
        assert.match(output, /^ai_videos\{status="failed"\} 2$/m);
        assert.doesNotMatch(output, /status="published"/);
    } finally {
        console.error = orig;
    }
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], /AI metrics query failed: relation "prv_ai_videos" does not exist/);
});
