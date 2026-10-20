'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LANGS, DEFAULT_LANG, LOCALES, isHtmlKey, translator, pickLang } = require('../lib/i18n');

test('t interpolates an _html key and escapes only its params', () => {
    const t = translator('en');
    assert.equal(t('toolbar_reviewer_html', { name: '<b>x</b>' }), 'Reviewer: <strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    assert.equal(t.text('toolbar_switch'), 'switch');
});

test('t and t.text return plain keys as written; t.text refuses _html keys', () => {
    const t = translator('ru');
    assert.equal(t.text('picker_empty'), LOCALES.ru.picker_empty);
    assert.equal(t('picker_prompt'), LOCALES.ru.picker_prompt);
    assert.throws(() => t.text('toolbar_reviewer_html'), /markup/);
});

test('params of a plain key are escaped by t, raw in t.text', () => {
    const t = translator('en');
    assert.equal(t('conflict_locked', { name: '<b>' }), '&lt;b&gt; holds this batch.');
    assert.equal(t.text('conflict_locked', { name: '<b>' }), '<b> holds this batch.');
});

// The page renders these by batch state / 409 reason; a missing one is a 500 in prod.
test('every batch state and conflict reason has its strings', () => {
    const keys = [
        ...['mine', 'available', 'locked', 'done', 'closed'].flatMap(s => [`state_${s}`, `lock_${s}`]),
        ...['available', 'locked', 'done', 'closed'].map(r => `conflict_${r}`),
    ];
    for (const lang of LANGS) {
        for (const key of keys) assert.equal(typeof LOCALES[lang][key], 'string', `${lang}.${key}`);
    }
});

test('a placeholder without a param stays as is', () => {
    assert.equal(translator('en')('toolbar_reviewer_html'), 'Reviewer: <strong>{name}</strong>');
});

test('unknown or missing lang falls back to ru', () => {
    for (const lang of ['de', undefined, null, '']) {
        const t = translator(lang);
        assert.equal(t.lang, DEFAULT_LANG);
        assert.equal(t.text('toolbar_switch'), LOCALES.ru.toolbar_switch);
    }
});

test('a missing key throws', () => {
    assert.throws(() => translator('en')('no_such_key'), /unknown key no_such_key/);
    assert.throws(() => translator('ru').text('no_such_key'), /unknown key no_such_key/);
});

test('ru and en have the same keys and placeholders', () => {
    const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(Object.keys(LOCALES.en).sort(), Object.keys(LOCALES.ru).sort());
    for (const key of Object.keys(LOCALES.ru)) {
        assert.deepEqual(placeholders(LOCALES.en[key]), placeholders(LOCALES.ru[key]), key);
    }
});

test('only _html keys contain markup', () => {
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(LOCALES[lang])) {
            assert.equal(typeof value, 'string', `${lang}.${key}`);
            if (!isHtmlKey(key)) assert.doesNotMatch(value, /[<>&]/, `${lang}.${key}`);
        }
    }
});

test('pickLang: query, then cookie, then ru', () => {
    assert.equal(pickLang({ query: { lang: 'en' }, headers: { cookie: 'review_lang=ru' } }), 'en');
    assert.equal(pickLang({ query: {}, headers: { cookie: 'a=1; review_lang=en; b=2' } }), 'en');
    assert.equal(pickLang({ query: { lang: 'de' }, headers: { cookie: 'review_lang=en' } }), 'en');
    assert.equal(pickLang({ query: {}, headers: { cookie: 'review_lang=de' } }), 'ru');
    assert.equal(pickLang({ query: {}, headers: {} }), 'ru');
    assert.equal(pickLang({}), 'ru');
});
