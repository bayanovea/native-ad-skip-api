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
    if (process.env.LEGACY_PRV) await renameLegacyObjects(sequelize, process.env.LEGACY_PRV);
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
    // Nullable, and unique on COALESCE(sheet, batch): a pre-2026-10-20 image inserts items without
    // `sheet` (ON CONFLICT on the (batch, item_code) index, which stays), so a rollback keeps importing.
    await sequelize.query('ALTER TABLE prv_review_items ADD COLUMN IF NOT EXISTS sheet VARCHAR(64) NULL');
    await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS prv_review_items_sheet_item_code
            ON prv_review_items ((COALESCE(sheet, batch)), item_code)`);
    // AI judge items (kind 'ai'); the defaults keep a pre-AI image's inserts working.
    await sequelize.query(
        `ALTER TABLE prv_review_items
            ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sheet',
            ADD COLUMN IF NOT EXISTS video_id INTEGER NULL`);
    // Assessor-corrected segment bounds on a verdict (2026-10-24); nullable, so a pre-bounds image keeps inserting.
    await sequelize.query(
        `ALTER TABLE prv_review_verdicts
            ADD COLUMN IF NOT EXISTS start INTEGER NULL,
            ADD COLUMN IF NOT EXISTS "end" INTEGER NULL,
            ADD COLUMN IF NOT EXISTS bounds_source VARCHAR(8) NULL`);
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
            ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'important',
            ADD COLUMN IF NOT EXISTS locked_by VARCHAR(64) NULL,
            ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE NULL,
            ADD COLUMN IF NOT EXISTS assignee VARCHAR(64) NULL`);
    await migrateBatchAssignees(sequelize);
    await sequelize.query('ALTER TABLE prv_ai_videos ADD COLUMN IF NOT EXISTS views_text VARCHAR(128) NULL');
    await sequelize.query('ALTER TABLE prv_ai_videos ADD COLUMN IF NOT EXISTS queued_by TEXT NULL');
    await sequelize.query(`ALTER TABLE prv_ai_video_calculateds ADD COLUMN IF NOT EXISTS hidden JSONB NOT NULL DEFAULT '[]'`);
    await sequelize.query('ALTER TABLE prv_ai_runs ADD COLUMN IF NOT EXISTS chapters JSONB NULL');
    // The detect queue's human-markup factor looks videos up by native_id once per eligible row (ai/pipeline/queue.go).
    await sequelize.query('CREATE INDEX IF NOT EXISTS videos_native_id ON videos (native_id)');
    // 2026-11-03: the chapter check published an empty served list as JSON null (fixed in
    // ai/pipeline/chapters.go); jsonb_array_length / .map on such a row fail the judge and the review page.
    await sequelize.query(`UPDATE prv_ai_video_calculateds SET data = '[]' WHERE jsonb_typeof(data) = 'null'`);
    // Items imported before prv_review_batches existed; the lock model needs a row per batch.
    await sequelize.query(
        `INSERT INTO prv_review_batches (batch)
         SELECT DISTINCT batch FROM prv_review_items
         ON CONFLICT DO NOTHING`);
    await syncCategories(sequelize, providers);
}

// The ids the extension sends on every provider, the ones prv serves. The old create() seed gave a
// fresh table 1..4; only that exact seed with nothing written yet is renumbered, any other state is
// left as is with a warning, and a failure here never fails the boot.
const CATEGORY_IDS = { intro: 3, sponsor: 4, self_promotion: 5, credits: 6 };
const OLD_SEED_IDS = { intro: 1, sponsor: 2, self_promotion: 3, credits: 4 };

async function syncCategories(sequelize, providers) {
    for (const models of providers) {
        const { MarkupCategory } = models;
        const table = MarkupCategory.getTableName();
        try {
            await sequelize.transaction((transaction) => syncProviderCategories(sequelize, models, table, transaction));
        } catch (err) {
            console.error(`${table}: category sync failed, left as is:`, err.message);
        }
    }
}

async function syncProviderCategories(sequelize, models, table, transaction) {
    const { MarkupCategory } = models;
    const is = (rows, ids) => rows.length === Object.keys(ids).length && rows.every((c) => c.id === ids[c.category]);
    // Self-conflicting, so two boots never renumber at once.
    await sequelize.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`, { transaction });
    const rows = await MarkupCategory.findAll({ order: [['id', 'ASC']], transaction });
    if (is(rows, CATEGORY_IDS)) return;
    const describe = rows.map((c) => `${c.id}=${c.category}`).join(' ');
    if (rows.length && !is(rows, OLD_SEED_IDS)) {
        console.warn(`${table}: ids ${describe} left as is: not the extension's ids nor the old seed`);
        return;
    }
    if (rows.length) {
        // Every table that can hold a category id: a category_id column, or the served JSON.
        const users = Object.values(models).filter((m) => m !== MarkupCategory
            && (m.rawAttributes.category_id || m === models.VideoCalculated || m === models.AiVideoCalculated));
        await sequelize.query(`LOCK TABLE ${users.map((m) => m.getTableName()).join(', ')} IN SHARE MODE`, { transaction });
        const used = [];
        for (const m of users) if (await m.count({ transaction })) used.push(m.getTableName());
        if (used.length) {
            console.warn(`${table}: old seed ${describe} left as is: ${used.join(', ')} have rows`);
            return;
        }
        await MarkupCategory.destroy({ where: {}, transaction });
    }
    await MarkupCategory.bulkCreate(Object.entries(CATEGORY_IDS).map(([category, id]) => ({ id, category })), { transaction });
    await sequelize.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`,
        { transaction });
}

// One-off (2026-10-20): batch assignment → first-come locks. gkshi batches
// are blind copies of bayanovea's sheets, so bayanovea may never take them;
// an assignee's unfinished batch stays with them as a lock (gkshi's only once
// started, so the untouched overlap batches go to anyone else). `assignee` is
// kept (nullable, unused by this code) and cleared instead of dropped, because
// a pre-2026-10-20 image inserts it on boot and rollback must keep working; a
// roll-forward then migrates only the rows that image assigned meanwhile.
async function migrateBatchAssignees(sequelize) {
    const worked = `EXISTS (SELECT 1 FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
                             WHERE i.batch = b.batch AND v.reviewer = b.assignee)`;
    const finished = `NOT EXISTS (SELECT 1 FROM prv_review_items i
                                   WHERE i.batch = b.batch AND NOT EXISTS (
                                         SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id AND v.reviewer = b.assignee))`;
    await sequelize.transaction(async (transaction) => {
        await sequelize.query(
            `UPDATE prv_review_batches b SET excluded = '{bayanovea}' WHERE b.assignee = 'gkshi'`,
            { transaction });
        await sequelize.query(
            `UPDATE prv_review_batches b SET locked_by = b.assignee, locked_at = CURRENT_TIMESTAMP
              WHERE b.assignee IS NOT NULL AND b.locked_by IS NULL AND NOT ${finished}
                AND (b.assignee <> 'gkshi' OR ${worked})`,
            { transaction });
        await sequelize.query('UPDATE prv_review_batches SET assignee = NULL WHERE assignee IS NOT NULL', { transaction });
    });
}

// One-off (2026-10-29): a DB created earlier carries the LEGACY_PRV prefix in every table,
// index, sequence and constraint name and in the two user id columns. Runs before sync(), which would otherwise create empty prv_* tables next to the old
// ones; a second boot finds nothing.
async function renameLegacyObjects(sequelize, legacy) {
    checkLegacy(legacy);
    const n = await renamePrefix(sequelize, legacy, 'prv');
    if (n) console.log(`Legacy rename: ${n} objects`);
}

// The way back for a pre-2026-10-29 image (scripts/rename-to-legacy.js, with the app stopped).
async function renameToLegacy(sequelize, legacy) {
    checkLegacy(legacy);
    const n = await renamePrefix(sequelize, 'prv', legacy);
    if (n) console.log(`Rename to legacy: ${n} objects`);
    return n;
}

// An empty prefix would match every name, `prv` would rename nothing.
function checkLegacy(legacy) {
    if (typeof legacy !== 'string' || !/^[a-z][a-z0-9]*$/.test(legacy) || legacy === 'prv') {
        throw new Error(`invalid legacy prefix ${JSON.stringify(legacy)}: lowercase letters and digits, not prv`);
    }
}

// Constraints first: renaming a PK / unique constraint renames its index. Postgres renames a
// table's row type with the table. Returns the number of objects renamed.
async function renamePrefix(sequelize, from, to) {
    const prefix = `${from}_`, inner = `_${from}_user_id`;
    const rename = (name) =>
        (name.startsWith(prefix) ? `${to}_${name.slice(prefix.length)}` : name).replace(inner, `_${to}_user_id`);
    const q = (name) => `"${name.replace(/"/g, '""')}"`;
    const carries = (col) => `(left(${col}, :n) = :prefix OR position(:inner IN ${col}) > 0)`;
    const replacements = { n: prefix.length, prefix, inner, from, to, columns: [`${from}_user_id`, `deleted_by_${from}_user_id`] };
    let n = 0;
    await sequelize.transaction(async (transaction) => {
        const opts = { replacements, transaction };
        const [constraints] = await sequelize.query(
            `SELECT con.conname AS name, rel.relname AS "table"
               FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
               JOIN pg_namespace ns ON ns.oid = rel.relnamespace
              WHERE ns.nspname = 'public' AND ${carries('con.conname')}`, opts);
        for (const { name, table } of constraints) {
            await sequelize.query(`ALTER TABLE ${q(table)} RENAME CONSTRAINT ${q(name)} TO ${q(rename(name))}`, { transaction });
        }
        const kinds = { r: 'TABLE', i: 'INDEX', S: 'SEQUENCE' };
        const [relations] = await sequelize.query(
            `SELECT c.relname AS name, c.relkind AS kind
               FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'i', 'S') AND ${carries('c.relname')}`, opts);
        for (const { name, kind } of relations) {
            await sequelize.query(`ALTER ${kinds[kind]} ${q(name)} RENAME TO ${q(rename(name))}`, { transaction });
        }
        const [columns] = await sequelize.query(
            `SELECT table_name AS "table", column_name AS name FROM information_schema.columns
              WHERE table_schema = 'public' AND column_name IN (:columns)`, opts);
        for (const { table, name } of columns) {
            await sequelize.query(
                `ALTER TABLE ${q(table)} RENAME COLUMN ${q(name)} TO ${q(name.replace(`${from}_user_id`, `${to}_user_id`))}`,
                { transaction });
        }
        n = constraints.length + relations.length + columns.length;
        const [[{ exists }]] = await sequelize.query(
            `SELECT to_regclass('public.calculator_heartbeats') IS NOT NULL AS exists`, { transaction });
        if (exists) {
            const [, result] = await sequelize.query(
                `UPDATE calculator_heartbeats SET provider = :to WHERE provider = :from`, opts);
            n += result.rowCount;
        }
    });
    return n;
}

module.exports = { syncSchema, syncCategories, CATEGORY_IDS, REVIEWERS, renameLegacyObjects, renameToLegacy };
