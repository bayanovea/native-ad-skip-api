'use strict';

// Schema bootstrap shared by the app (db.js bootstrap(), on every boot) and
// scripts/sync-db.js, so both leave a DB in the same shape.
//
// sync() creates missing tables but never alters existing ones, so changes to
// tables that may already exist go here as idempotent ALTERs.

// Seed reviewer codes; assessors add themselves on the review page picker
// (POST /admin/review/reviewers), and the page reads the table.
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
    // Verdicts recorded before reviewers existed (2026-10-18) were all the
    // owner's. Runs before the batch one-off, which counts verdicts per reviewer.
    await sequelize.query(
        `UPDATE prv_review_verdicts SET reviewer = 'bayanovea'
          WHERE reviewer NOT IN (SELECT code FROM prv_review_reviewers)`);
    await sequelize.query(
        `ALTER TABLE prv_review_batches
            ADD COLUMN IF NOT EXISTS reviews_needed INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS excluded TEXT[] NOT NULL DEFAULT '{}',
            ADD COLUMN IF NOT EXISTS locked_by VARCHAR(64) NULL,
            ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE NULL`);
    await dropBatchAssignee(sequelize);
    // Items imported before prv_review_batches existed; the lock model needs a row per batch.
    await sequelize.query(
        `INSERT INTO prv_review_batches (batch)
         SELECT DISTINCT batch FROM prv_review_items
         ON CONFLICT DO NOTHING`);
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

// One-off (2026-10-20): batch assignment → first-come locks. gkshi batches
// are blind copies of bayanovea's sheets, so bayanovea may never take them;
// an assignee's unfinished batch stays with them as a lock (gkshi's only once
// started, so the untouched overlap batches go to anyone else). Runs while the
// column exists, in one transaction so a failed boot retries it whole.
async function dropBatchAssignee(sequelize) {
    const [rows] = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'prv_review_batches' AND column_name = 'assignee'`);
    if (rows.length === 0) return;
    const worked = `EXISTS (SELECT 1 FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
                             WHERE i.batch = b.batch AND v.reviewer = b.assignee)`;
    const finished = `NOT EXISTS (SELECT 1 FROM prv_review_items i
                                   WHERE i.batch = b.batch AND NOT EXISTS (
                                         SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id AND v.reviewer = b.assignee))`;
    await sequelize.transaction(async (transaction) => {
        await sequelize.query(
            `UPDATE prv_review_batches b SET excluded = '{bayanovea}', reviews_needed = 1 WHERE b.assignee = 'gkshi'`,
            { transaction });
        await sequelize.query(
            `UPDATE prv_review_batches b SET locked_by = b.assignee, locked_at = CURRENT_TIMESTAMP
              WHERE b.assignee IS NOT NULL AND NOT ${finished}
                AND (b.assignee <> 'gkshi' OR ${worked})`,
            { transaction });
        await sequelize.query('ALTER TABLE prv_review_batches DROP COLUMN assignee', { transaction });
    });
}

module.exports = { syncSchema, REVIEWERS };
