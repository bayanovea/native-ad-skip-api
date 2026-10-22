'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// AI_FIRST is read when the module loads, so each test loads it afresh under its env.
function load(aiFirst) {
    if (aiFirst === undefined) delete process.env.AI_FIRST;
    else process.env.AI_FIRST = aiFirst;
    delete require.cache[require.resolve('../lib/find-ai-calculated')];
    return require('../lib/find-ai-calculated').findAiCalculated;
}

afterEach(() => { delete process.env.AI_FIRST; });

// A stub AiVideoCalculated over `rows` that honours the where clause the helper sends.
function makeModels(rows) {
    const calls = [];
    return {
        calls,
        models: {
            AiVideoCalculated: {
                async findOne(opts) {
                    calls.push(opts);
                    const { video_id, withdrawn_at } = opts.where;
                    return rows.find(r => r.video_id === video_id && r.withdrawn_at === withdrawn_at) || null;
                },
            },
        },
    };
}

const active = { video_id: 1, withdrawn_at: null, data: [{ category_id: 2, start: 30, end: 70, source: 'ai' }] };

test('AI_FIRST on: the active row with entries is returned', async () => {
    const findAiCalculated = load('on');
    const { models, calls } = makeModels([active]);
    assert.equal(await findAiCalculated(models, 1), active);
    assert.equal(await findAiCalculated(models, 2), null, 'no row for that videos row');
    assert.equal(calls.length, 2);
});

test('AI_FIRST off or unset: no AI row and no query', async () => {
    for (const flag of ['off', undefined, 'true']) {
        const findAiCalculated = load(flag);
        const { models, calls } = makeModels([active]);
        assert.equal(await findAiCalculated(models, 1), null, `AI_FIRST=${flag}`);
        assert.equal(calls.length, 0);
    }
});

test('a withdrawn row is not served', async () => {
    const findAiCalculated = load('on');
    const { models } = makeModels([{ ...active, withdrawn_at: new Date() }]);
    assert.equal(await findAiCalculated(models, 1), null);
});

test('a row published with nothing to skip (empty or missing data) is not served', async () => {
    const findAiCalculated = load('on');
    assert.equal(await findAiCalculated(makeModels([{ ...active, data: [] }]).models, 1), null);
    assert.equal(await findAiCalculated(makeModels([{ ...active, data: null }]).models, 1), null);
});

test('transaction and lock are passed through', async () => {
    const findAiCalculated = load('on');
    const { models, calls } = makeModels([active]);
    const transaction = { id: 't' };
    await findAiCalculated(models, 1, { transaction, lock: 'UPDATE' });
    assert.equal(calls[0].transaction, transaction);
    assert.equal(calls[0].lock, 'UPDATE');
});

test('the AI row is served only when the player duration fits the videos row', () => {
    const { AI_LOOKUP_OUTCOMES } = require('../lib/find-ai-calculated');
    assert.deepEqual([...AI_LOOKUP_OUTCOMES].sort(), ['backfilled', 'match']);
});
