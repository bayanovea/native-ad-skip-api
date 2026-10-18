'use strict';

// Schema bootstrap shared by the app (db.js bootstrap(), on every boot) and
// scripts/sync-db.js, so both leave a DB in the same shape.
//
// sync() creates missing tables but never alters existing ones, so changes to
// tables that may already exist go here as idempotent ALTERs.

// Reviewer codes the review page offers. New assessors: add a row here (or by
// hand in prv_review_reviewers); the page reads the table.
const REVIEWERS = ['bayanovea', 'gkshi'];

async function syncSchema(sequelize, providers) {
    await sequelize.sync();
    await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP NULL');
    // video_calculateds.meta: the calculator stopped writing it in 6aa6cbf, nothing reads it.
    for (const table of ['video_calculateds', 'rt_video_calculateds', 'yt_video_calculateds']) {
        await sequelize.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS meta`);
    }
    // Review tables created before the DB-side timestamp defaults existed
    // (pre-17886cb DDL: NOT NULL, no default).
    await sequelize.query('ALTER TABLE prv_review_items ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP');
    await sequelize.query('ALTER TABLE prv_review_verdicts ALTER COLUMN decided_at SET DEFAULT CURRENT_TIMESTAMP');
    for (const code of REVIEWERS) {
        await sequelize.query('INSERT INTO prv_review_reviewers (code) VALUES (:code) ON CONFLICT DO NOTHING',
            { replacements: { code } });
    }
    // One-off for the batches and verdicts recorded before reviewers and batch
    // assignment existed (2026-10-18): all of them were the owner's. A no-op
    // once every batch has a row and every verdict a known reviewer.
    await sequelize.query(
        `INSERT INTO prv_review_batches (batch, assignee)
         SELECT DISTINCT batch, 'bayanovea' FROM prv_review_items
         ON CONFLICT DO NOTHING`);
    await sequelize.query(
        `UPDATE prv_review_verdicts SET reviewer = 'bayanovea'
          WHERE reviewer NOT IN (SELECT code FROM prv_review_reviewers)`);
    for (const { MarkupCategory } of providers) {
        const categories = await MarkupCategory.findAll();
        if (!categories.length) {
            await MarkupCategory.create({ category: 'intro' });
            await MarkupCategory.create({ category: 'sponsor' });
            await MarkupCategory.create({ category: 'self_promotion' });
            await MarkupCategory.create({ category: 'credits' });
        }
    }
}

module.exports = { syncSchema, REVIEWERS };
