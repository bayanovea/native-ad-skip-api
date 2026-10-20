'use strict';

const path = require('path');
const { escapeHtml } = require('./admin-html');

// Review page strings (prv/locales/review/<lang>.json, flat key → string with
// `{name}` placeholders). Russian is the reference: the assessors read it, and
// a key missing in another language falls back to it.
const LANGS = Object.freeze(['ru', 'en']);
const DEFAULT_LANG = 'ru';
const COOKIE = 'review_lang';
const LOCALES = Object.freeze(Object.fromEntries(LANGS.map(lang =>
    [lang, Object.freeze(require(path.join(__dirname, '..', 'prv', 'locales', 'review', `${lang}.json`)))])));

function isHtmlKey(key) {
    return key.endsWith('_html');
}

function interpolate(template, params, escape) {
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        (params && params[name] != null ? escape(params[name]) : match));
}

function lookup(lang, key) {
    const value = LOCALES[lang][key] ?? LOCALES[DEFAULT_LANG][key];
    if (value == null) throw new Error(`i18n: unknown key ${key}`);
    return value;
}

// `t(key, params)` returns HTML: plain keys escaped as a whole, `_html` keys
// (markup from these repo-owned files) raw with only the params escaped.
// `t.text(key, params)` returns plain text for the inline script's STATE.
function translator(lang) {
    const resolved = LANGS.includes(lang) ? lang : DEFAULT_LANG;
    const t = (key, params) => (isHtmlKey(key)
        ? interpolate(lookup(resolved, key), params, escapeHtml)
        : escapeHtml(interpolate(lookup(resolved, key), params, String)));
    t.text = (key, params) => {
        if (isHtmlKey(key)) throw new Error(`i18n: ${key} is markup, not text`);
        return interpolate(lookup(resolved, key), params, String);
    };
    t.lang = resolved;
    return t;
}

function cookieLang(header) {
    for (const part of String(header || '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE) return rest.join('=');
    }
    return null;
}

// `?lang=` first (the toolbar switch), then the cookie it set, then Russian.
function pickLang(req) {
    const query = req.query && req.query.lang;
    if (LANGS.includes(query)) return query;
    const cookie = cookieLang(req.headers && req.headers.cookie);
    return LANGS.includes(cookie) ? cookie : DEFAULT_LANG;
}

module.exports = { LANGS, DEFAULT_LANG, COOKIE, LOCALES, isHtmlKey, translator, pickLang };
