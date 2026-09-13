'use strict';

const fs = require('fs');
const path = require('path');
const { connect, isConfigured } = require('./pool');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';

const MIGRATION_FILE_PATTERN = /^([0-9]+)_[a-zA-Z0-9_-]+\.sql$/;

function isStatusMode() {
    return process.argv.includes('--status') || process.argv.includes('-s');
}

// Rolls back a client's open transaction, swallowing any secondary error so the
// original failure is preserved. This is intentionally NOT a transaction itself:
// it only fires after a matching BEGIN.
async function rollbackQuietly(client) {
    try {
        await client.query('ROLLBACK');
    } catch (_rollbackErr) {
        // Preserve the original error.
    }
}

function readMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    }

    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((name) => MIGRATION_FILE_PATTERN.test(name))
        .sort();

    return files.map((file) => {
        const match = MIGRATION_FILE_PATTERN.exec(file);
        return {
            version: match[1],
            name: file,
            sqlPath: path.join(MIGRATIONS_DIR, file)
        };
    });
}

async function getApplied(client) {
    const result = await client.query(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`);
    return new Map(result.rows.map((row) => [row.version, row]));
}

async function ensureMigrationTable(client) {
    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
                version    TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await client.query('COMMIT');
        began = false;
    } catch (err) {
        if (began) {
            await rollbackQuietly(client);
        }
        throw err;
    }
}

async function runMigration(client, migration) {
    const sql = fs.readFileSync(migration.sqlPath, 'utf8').trim();

    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        if (sql) {
            await client.query(sql);
        }
        await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2)`,
            [migration.version, migration.name]
        );
        await client.query('COMMIT');
        began = false;
        console.log(`[migrate] Applied  ${migration.name}`);
    } catch (err) {
        if (began) {
            await rollbackQuietly(client);
        }
        throw new Error(`Migration ${migration.name} failed and was rolled back: ${err.message || err}`);
    }
}

async function status(client, migrations) {
    const applied = await getApplied(client);

    console.log('');
    console.log('Migration status:');
    console.log('-----------------');

    if (migrations.length === 0) {
        console.log('  (no migration files found)');
        console.log('');
        return;
    }

    for (const migration of migrations) {
        const record = applied.get(migration.version);
        if (record) {
            console.log(`  [x] ${migration.name}  (applied ${new Date(record.applied_at).toISOString()})`);
        } else {
            console.log(`  [ ] ${migration.name}`);
        }
    }

    // Warn about applied migrations whose file no longer exists (defensive).
    const versions = new Set(migrations.map((m) => m.version));
    for (const [version, record] of applied) {
        if (!versions.has(version)) {
            console.warn(`  [!] ${record.name} is recorded as applied but the file is missing.`);
        }
    }

    console.log('');
}

async function main() {
    if (!isConfigured()) {
        console.error('[migrate] Refusing to run: DATABASE_URL is not configured.');
        console.error('[migrate] Set DATABASE_URL to a PostgreSQL connection string and try again.');
        process.exit(1);
    }

    const migrations = readMigrations();
    const client = await connect();

    try {
        await ensureMigrationTable(client);

        if (isStatusMode()) {
            await status(client, migrations);
            return;
        }

        await status(client, migrations);

        const applied = await getApplied(client);
        const pending = migrations.filter((migration) => !applied.has(migration.version));

        if (pending.length === 0) {
            console.log('[migrate] Database is up to date. Nothing to do.');
            return;
        }

        console.log(`[migrate] Running ${pending.length} pending migration(s)…`);
        for (const migration of pending) {
            await runMigration(client, migration);
        }
        console.log('[migrate] Done.');
    } finally {
        client.release();
    }
}

main().catch((err) => {
    console.error('[migrate] Fatal:', err.message || err);
    process.exit(1);
});