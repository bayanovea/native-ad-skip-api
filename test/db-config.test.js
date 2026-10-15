'use strict';

// db.js connection options. No DB needed: the child process prints the port
// Sequelize was built with and exits before authenticate() can finish.
// Run: node --test test/db-config.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function portFor(extraEnv) {
    const env = { ...process.env, DB_NAME: 'db_config_test', DB_USER: 'u', DB_PASSWORD: 'p', DB_HOST: '127.0.0.1', ...extraEnv };
    if (extraEnv.DB_PORT === undefined) delete env.DB_PORT;
    const r = spawnSync(process.execPath, ['-e',
        "const { sequelize } = require('./db'); process.stdout.write(JSON.stringify({ host: sequelize.config.host, port: sequelize.config.port })); process.exit(0);",
    ], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

test('db.js: port defaults to 5432 when DB_PORT is unset (prod behaviour)', () => {
    assert.deepEqual(portFor({ DB_PORT: undefined }), { host: '127.0.0.1', port: 5432 });
});

test('db.js: DB_PORT is honoured (local restored dump on 5433)', () => {
    assert.deepEqual(portFor({ DB_PORT: '5433' }), { host: '127.0.0.1', port: 5433 });
});
