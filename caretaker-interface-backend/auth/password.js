'use strict';

const bcrypt = require('bcryptjs');

const ROUNDS = (() => {
    const raw = parseInt(process.env.BCRYPT_ROUNDS, 10);
    return Number.isFinite(raw) && raw >= 4 && raw <= 15 ? raw : 10;
})();

// bcrypt only uses the first 72 bytes of a password. We enforce that ceiling.
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;

const NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= EMAIL_MAX_LENGTH
        && EMAIL_PATTERN.test(value);
}

function isValidName(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.trim().length <= NAME_MAX_LENGTH;
}

function validatePassword(value) {
    if (typeof value !== 'string') {
        return { ok: false, error: 'Password is required' };
    }
    if (value.length < PASSWORD_MIN_LENGTH) {
        return {
            ok: false,
            error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
        };
    }
    if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) {
        return {
            ok: false,
            error: `Password must be at most ${PASSWORD_MAX_BYTES} bytes`
        };
    }
    return { ok: true };
}

async function hashPassword(password) {
    return bcrypt.hash(password, ROUNDS);
}

async function verifyPassword(password, passwordHash) {
    if (typeof password !== 'string' || typeof passwordHash !== 'string') {
        return false;
    }
    return bcrypt.compare(password, passwordHash);
}

function safeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
    };
}

module.exports = {
    ROUNDS,
    normalizeEmail,
    isValidEmail,
    isValidName,
    validatePassword,
    hashPassword,
    verifyPassword,
    safeUser
};