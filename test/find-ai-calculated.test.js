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

// A stub AiVideoCalculated over `rows` that honours the where clause the helper sends (the row in any state).
function makeModels(rows) {
    const calls = [];
    return {
        calls,
        models: {
            AiVideoCalculated: {
                async findOne(opts) {
                    calls.push(opts);
                    return rows.find(r => r.video_id === opts.where.video_id) || null;
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

test('the transaction is passed through', async () => {
    const findAiCalculated = load('on');
    const { models, calls } = makeModels([active]);
    const transaction = { id: 't' };
    await findAiCalculated(models, 1, { transaction });
    assert.equal(calls[0].transaction, transaction);
});

test('lockAiCalculated: the row in any state (also with AI_FIRST off), FOR UPDATE in the transaction', async () => {
    load(undefined);
    const { lockAiCalculated, servesAi } = require('../lib/find-ai-calculated');
    const withdrawn = { ...active, withdrawn_at: new Date() };
    const calls = [];
    const models = { AiVideoCalculated: { async findOne(opts) { calls.push(opts); return withdrawn; } } };
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    assert.equal(await lockAiCalculated(models, 1, { transaction }), withdrawn);
    assert.deepEqual(calls[0], { where: { video_id: 1 }, lock: 'UPDATE', transaction });
    assert.equal(servesAi(active), false, 'AI_FIRST off: nothing is served');
});

test('servesAi: AI_FIRST on, not withdrawn, something published', () => {
    load('on');
    const { servesAi } = require('../lib/find-ai-calculated');
    assert.equal(servesAi(active), true);
    for (const row of [null, { ...active, withdrawn_at: new Date() }, { ...active, data: [] }, { ...active, data: null }]) {
        assert.equal(servesAi(row), false, JSON.stringify(row));
    }
});
