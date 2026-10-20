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
