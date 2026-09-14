'use strict';

/* Shared auth + blind-user API layer for the caretaker console.
 * Loaded by BOTH index.html (caretaker dashboard) and auth.html (sign in /
 * create account). The session is a browser-managed HttpOnly cookie, so every
 * authenticated request uses credentials:'include' and NO token is ever stored
 * in localStorage/sessionStorage.
 */

const AUTH_API_BASE_URL = (typeof window !== 'undefined' && window.API_BASE_URL)
    || ((typeof location !== 'undefined' && location.hostname)
        ? `${location.protocol}//${location.hostname}:3000`
        : 'http://localhost:3000');

const AUTH_REGISTER_ENDPOINT = `${AUTH_API_BASE_URL}/api/auth/register`;
const AUTH_LOGIN_ENDPOINT = `${AUTH_API_BASE_URL}/api/auth/login`;
const AUTH_LOGOUT_ENDPOINT = `${AUTH_API_BASE_URL}/api/auth/logout`;
const AUTH_ME_ENDPOINT = `${AUTH_API_BASE_URL}/api/auth/me`;
const BLIND_USERS_ENDPOINT = `${AUTH_API_BASE_URL}/api/blind-users`;
const CARETAKER_BLIND_USERS_ENDPOINT = `${AUTH_API_BASE_URL}/api/caretaker/blind-users`;
const DEVICES_ENDPOINT = `${AUTH_API_BASE_URL}/api/devices`;

const AUTH_FETCH_INIT = { credentials: 'include' };

async function readJsonOrText(response) {
    const type = (response.headers.get('content-type') || '');
    if (type.includes('application/json')) return response.json();
    const text = await response.text();
    return text ? { error: text } : null;
}

async function authApiFetch(url, options) {
    const init = Object.assign({}, AUTH_FETCH_INIT, options || {});

    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
        init.body = JSON.stringify(init.body);
        init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
    }

    const response = await fetch(url, init);
    const body = response.status === 204 ? null : await readJsonOrText(response).catch(() => null);

    if (!response.ok) {
        const message = (body && body.error) || `Request failed (HTTP ${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.body = body;
        throw error;
    }

    return body;
}

// GET /api/auth/me — resolves with { authenticated, user } or rejects (401/error).
async function checkCurrentUser() {
    return authApiFetch(AUTH_ME_ENDPOINT, { headers: { 'Accept': 'application/json' } });
}

// POST /api/auth/login — session cookie is set by the backend.
async function loginCaretaker(email, password) {
    return authApiFetch(AUTH_LOGIN_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: { email, password }
    });
}

// POST /api/auth/register — creates a CARETAKER account (no session cookie).
async function registerCaretaker(name, email, password) {
    return authApiFetch(AUTH_REGISTER_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: { name, email, password }
    });
}

// POST /api/auth/logout — invalidates the server session and clears the cookie.
async function logoutCaretaker() {
    return authApiFetch(AUTH_LOGOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
    });
}

// GET /api/caretaker/blind-users — the authenticated caretaker's authorized
// blind users (ACTIVE relationships only). Backend remains the authority.
async function fetchAuthorizedBlindUsers() {
    return authApiFetch(CARETAKER_BLIND_USERS_ENDPOINT, { headers: { 'Accept': 'application/json' } });
}

// POST /api/blind-users — create a blind-user identity (caretaker-only).
async function createBlindUserIdentity(name, email) {
    return authApiFetch(BLIND_USERS_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: { name, email }
    });
}

// POST /api/caretaker/blind-users/:blindUserId — link a blind user to the
// authenticated caretaker (idempotent; caretaker id always comes from session).
async function linkBlindUserToCaretaker(blindUserId) {
    return authApiFetch(`${CARETAKER_BLIND_USERS_ENDPOINT}/${encodeURIComponent(blindUserId)}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
    });
}

// PATCH /api/blind-users/:blindUserId — update identity (caretaker + ACTIVE relationship).
async function updateBlindUserIdentity(blindUserId, patch) {
    return authApiFetch(`${BLIND_USERS_ENDPOINT}/${encodeURIComponent(blindUserId)}`, {
        method: 'PATCH',
        headers: { 'Accept': 'application/json' },
        body: patch
    });
}

// DELETE /api/caretaker/blind-users/:blindUserId — deactivate the relationship.
async function deactivateBlindUserRelationship(blindUserId) {
    return authApiFetch(`${CARETAKER_BLIND_USERS_ENDPOINT}/${encodeURIComponent(blindUserId)}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
    });
}

/* ── Device (assistive cap) management ───────────────────────────── */

// GET /api/devices?blindUserId=<uuid> — devices of one linked blind user.
async function fetchDevicesForBlindUser(blindUserId) {
    return authApiFetch(`${DEVICES_ENDPOINT}?blindUserId=${encodeURIComponent(blindUserId)}`, {
        headers: { 'Accept': 'application/json' }
    });
}

// POST /api/devices — register a cap device. Resolves { device, token };
// the token is shown exactly once by the caller.
async function registerDevice(blindUserId, deviceIdentifier, friendlyName) {
    return authApiFetch(DEVICES_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: { blindUserId, deviceIdentifier, friendlyName: friendlyName || undefined }
    });
}

// POST /api/devices/:deviceId/rotate — replace the pairing secret.
// Resolves { device, token } with the new one-time token.
async function rotateDeviceToken(deviceId) {
    return authApiFetch(`${DEVICES_ENDPOINT}/${encodeURIComponent(deviceId)}/rotate`, {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
    });
}

/* ── Sign In / Create Account page logic (auth.html only) ─────────────── */

(function initAuthPage() {
    const card = document.getElementById('authCard');
    if (!card) return; // not running on the auth page

    const formGroup = card.querySelectorAll('.auth-form');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');

    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    const loginError = document.getElementById('loginError');
    const loginSubmit = document.getElementById('loginSubmit');

    const regName = document.getElementById('regName');
    const regEmail = document.getElementById('regEmail');
    const regPassword = document.getElementById('regPassword');
    const regError = document.getElementById('regError');
    const regSubmit = document.getElementById('regSubmit');
    const authNote = document.getElementById('authNote');

    const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    function setError(el, message) {
        if (!el) return;
        el.textContent = message || '';
        el.classList.toggle('visible', Boolean(message));
    }

    function setNote(message) {
        if (!authNote) return;
        authNote.textContent = message || '';
        authNote.classList.toggle('visible', Boolean(message));
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        button.disabled = busy;
        button.textContent = label;
    }

    function showTab(tab) {
        const login = tab === 'login';
        if (loginForm) loginForm.hidden = !login;
        if (registerForm) registerForm.hidden = login;
        if (tabLogin) tabLogin.classList.toggle('active', login);
        if (tabRegister) tabRegister.classList.toggle('active', !login);
        setError(loginError, null);
        setError(regError, null);
        setNote('');
    }

    if (tabLogin) tabLogin.addEventListener('click', () => showTab('login'));
    if (tabRegister) tabRegister.addEventListener('click', () => showTab('register'));

    // Session check: if already authenticated, skip the login page entirely.
    checkCurrentUser()
        .then((body) => {
            if (body && body.user) window.location.replace('index.html');
        })
        .catch(() => { /* not authenticated — show the form */ });

    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!loginEmail || !loginPassword) return;

            const email = loginEmail.value.trim();
            const password = loginPassword.value;

            setError(loginError, null);
            if (!email) return setError(loginError, 'Enter your email address.');
            if (!password) return setError(loginError, 'Enter your password.');

            setBusy(loginSubmit, true, 'Signing in…');
            try {
                await loginCaretaker(email, password);
                window.location.replace('index.html');
            } catch (err) {
                setBusy(loginSubmit, false, 'Sign In');
                setError(loginError, err.message || 'Sign in failed. Please try again.');
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!regName || !regEmail || !regPassword) return;

            const name = regName.value.trim();
            const email = regEmail.value.trim();
            const password = regPassword.value;

            setError(regError, null);
            if (!name) return setError(regError, 'Enter your full name.');
            if (!EMAIL_PATTERN.test(email)) return setError(regError, 'Enter a valid email address.');
            if (password.length < 8) return setError(regError, 'Password must be at least 8 characters.');

            setBusy(regSubmit, true, 'Creating account…');
            try {
                await registerCaretaker(name, email, password);
                if (loginEmail) loginEmail.value = email;
                if (loginPassword) loginPassword.value = '';
                setBusy(regSubmit, false, 'Create Account');
                setError(regError, null);
                setNote('Account created. Sign in with your new credentials.');
                showTab('login');
            } catch (err) {
                setBusy(regSubmit, false, 'Create Account');
                setError(regError, err.message || 'Registration failed. Please try again.');
            }
        });
    }

    window.__authFormGroup = formGroup; // (unused) keep native form grouping reference
})();