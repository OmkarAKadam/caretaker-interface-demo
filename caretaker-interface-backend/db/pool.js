'use strict';

const { Pool } = require('pg');

const CONFIG_ERROR_MESSAGE =
    'DATABASE_URL is not configured. Set DATABASE_URL to a PostgreSQL ' +
    'connection string (e.g. postgres://user:password@host:5432/dbname) ' +
    'before using the database. The REST API does not require a database.';

let pool = null;

function isConfigured() {
    const url = process.env.DATABASE_URL;
    return typeof url === 'string' && url.trim() !== '';
}

// Lazily creates the pool. Requiring this module never fails; only an actual
// database operation fails when DATABASE_URL is missing. This keeps the
// existing backend fully operational without a database configured.
function getPool() {
    if (!isConfigured()) {
        throw new Error(CONFIG_ERROR_MESSAGE);
    }
    if (!pool) {
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
        pool.on('error', (err) => {
            console.error('[db] idle client error:', err.message || err);
        });
    }
    return pool;
}

function query(text, params) {
    return getPool().query(text, params);
}

function connect() {
    return getPool().connect();
}

module.exports = {
    query,
    connect,
    getPool,
    isConfigured
};