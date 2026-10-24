'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const client = require('prom-client');

// Reset the default registry between tests so counters start at 0. The wrapper
// module registers its counters on require, so reload it after clearing.
beforeEach(() => {
    client.register.clear();
    delete require.cache[require.resolve('../prometheus-wrapper.js')];
    delete require.cache[require.resolve('../lib/find-ai-calculated.js')]; // reads AI_FIRST when it loads
    delete process.env.AI_FIRST;
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

// A sequelize stub for registerAiMetrics: `answer(sql)` gives the rows of each query (or throws).
function fakeDb(answer) {
    const calls = [];
    return {
        calls,
        async query(sql) {
            calls.push(sql);
            return [answer(sql)];
        },
    };
}

const aiRows = (videos) => (sql) => {
    if (sql.includes('FROM prv_ai_videos')) return videos;
    if (sql.includes('cost_usd')) return [{ kind: 'detect', total: 0.125, day: 0.05 }, { kind: 'judge', total: 0, day: 0 }];
    if (sql.includes('FROM prv_ai_judgements')) return [{ decision: 'review', by: 'llm', n: '2' }];
    return [{ n: '4' }];
};

test('registerAiMetrics: one refresh per scrape fills the AI gauges', async () => {
    const wrapper = require('../prometheus-wrapper.js');
    const db = fakeDb(aiRows([{ status: 'published', n: '3' }, { status: 'seen', n: '7' }]));
    wrapper.registerAiMetrics(db);

    const output = await client.register.metrics();
    assert.equal(db.calls.length, 4, 'the gauges share one refresh of four queries');
    assert.match(output, /^ai_videos\{status="published"\} 3$/m);
    assert.match(output, /^ai_videos\{status="seen"\} 7$/m);
    assert.match(output, /^ai_cost_usd\{kind="detect"\} 0.125$/m);
    assert.match(output, /^ai_cost_usd\{kind="judge"\} 0$/m);
    assert.match(output, /^ai_cost_usd_24h\{kind="detect"\} 0.05$/m);
    assert.match(output, /^ai_cost_usd_24h\{kind="judge"\} 0$/m);
    assert.match(output, /^ai_judgements\{decision="review",by="llm"\} 2$/m);
    assert.match(output, /^ai_review_open 4$/m);
});

test('registerAiMetrics: ai_first_enabled is the AI_FIRST switch as read at boot', async () => {
    process.env.AI_FIRST = 'on';
    let wrapper = require('../prometheus-wrapper.js');
    wrapper.registerAiMetrics(fakeDb(aiRows([])));
    assert.match(await client.register.metrics(), /^ai_first_enabled 1$/m);

    client.register.clear();
    delete require.cache[require.resolve('../prometheus-wrapper.js')];
    delete require.cache[require.resolve('../lib/find-ai-calculated.js')];
    process.env.AI_FIRST = 'off';
    wrapper = require('../prometheus-wrapper.js');
    wrapper.registerAiMetrics(fakeDb(aiRows([])));
    assert.match(await client.register.metrics(), /^ai_first_enabled 0$/m);
});

test('registerAiMetrics: a failing query logs once and leaves the gauges empty; a later scrape fills them again', async () => {
    const wrapper = require('../prometheus-wrapper.js');
    const states = [
        aiRows([{ status: 'published', n: '1' }]),
        () => { throw new Error('relation "prv_ai_videos" does not exist'); },
        () => { throw new Error('relation "prv_ai_videos" does not exist'); },
        aiRows([{ status: 'failed', n: '2' }]),
    ];
    let state = states[0];
    const db = fakeDb(sql => state(sql));
    wrapper.registerAiMetrics(db);
    const logs = [];
    const orig = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
        assert.match(await client.register.metrics(), /^ai_videos\{status="published"\} 1$/m);
        for (let i = 1; i <= 2; i++) {
            state = states[i];
            const output = await client.register.metrics();
            assert.doesNotMatch(output, /^ai_videos\{/m, 'no stale series after a failure');
            assert.doesNotMatch(output, /^ai_judgements\{/m);
            assert.doesNotMatch(output, /^ai_cost_usd_24h\{/m);
        }
        state = states[3];
        const output = await client.register.metrics();
        assert.match(output, /^ai_videos\{status="failed"\} 2$/m);
        assert.doesNotMatch(output, /status="published"/);
    } finally {
        console.error = orig;
    }
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], /AI metrics query failed: relation "prv_ai_videos" does not exist/);
});
