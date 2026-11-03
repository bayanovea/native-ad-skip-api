'use strict';

// Renames the DB objects back from the prv form to the earlier prefix (lib/schema.js
// renameToLegacy), so an image older than 2026-10-29 can start. Run it only with the app
// stopped, right before starting that image. Tables created after the rename (they only ever had
// prv_ names) get the earlier prefix too; an old image ignores them. A later boot with LEGACY_PRV
// set renames everything forward again.
//
// Usage: DB_NAME=… DB_USER=… DB_PASSWORD=… [DB_HOST=localhost DB_PORT=5432] \
//        node scripts/rename-to-legacy.js <legacy>

const { scriptSequelize } = require('../lib/script-db');
const { renameToLegacy } = require('../lib/schema');

const legacy = process.argv[2];
if (!legacy || process.argv.length > 3) {
    console.error('usage: node scripts/rename-to-legacy.js <legacy>');
    process.exit(2);
}

async function main() {
    const sequelize = scriptSequelize();
    try {
        if (!await renameToLegacy(sequelize, legacy)) console.log('Rename to legacy: 0 objects');
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`rename to legacy failed: ${e.message}`);
    process.exit(1);
});
