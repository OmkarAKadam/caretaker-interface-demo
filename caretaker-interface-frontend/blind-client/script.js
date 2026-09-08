const API_BASE_URL =
    (typeof window !== 'undefined' && window.API_BASE_URL) ||
    'http://localhost:3000';
const LOCATION_ENDPOINT = `${API_BASE_URL}/api/location`;
const EVENTS_ENDPOINT = `${API_BASE_URL}/api/events`;
const STREAM_ENDPOINT = `${API_BASE_URL}/api/events/stream`;
const HEALTH_ENDPOINT = `${API_BASE_URL}/api/health`;

const DIRECTION_PHRASES = {
    OBSTACLE_LEFT: 'Obstacle on your left',
    OBSTACLE_CENTER: 'Obstacle ahead',
    OBSTACLE_RIGHT: 'Obstacle on your right'
};

const DIRECTION_LABELS = {
    OBSTACLE_LEFT: 'Left',
    OBSTACLE_CENTER: 'Center',
    OBSTACLE_RIGHT: 'Right'
};

const MOVE_STEP = 0.0005;
const MAX_SEEN_IDS = 50;
const BASE_RECONNECT_MS = 1500;
const MAX_RECONNECT_MS = 20000;

const seenIds = new Set();
const seenQueue = [];

let sharingEnabled = false;
let watchId = null;
let lastPosition = null;
let backendOnline = false;

let simEnabled = false;
let simLat = 22.3407;
let simLng = 73.1808;

let voiceEnabled = false;
let connection = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

const voiceCard = document.getElementById('voiceCard');
const voiceIcon = document.getElementById('voiceIcon');
const voiceStatus = document.getElementById('voiceStatus');
const voiceSub = document.getElementById('voiceSub');
const voiceBadge = document.getElementById('voiceBadge');
const voiceBadgeText = document.getElementById('voiceBadgeText');

const connChip = document.getElementById('connChip');
const connLabel = document.getElementById('connLabel');

const enableBtn = document.getElementById('enableBtn');
const enableBtnLabel = document.getElementById('enableBtnLabel');
const disableBtn = document.getElementById('disableBtn');

const lastAlertText = document.getElementById('lastAlertText');
const lastAlertMeta = document.getElementById('lastAlertMeta');
const directionChip = document.getElementById('directionChip');

const startBtn = document.getElementById('startBtn');
const startBtnLabel = document.getElementById('startBtnLabel');
const triggerBtn = document.getElementById('triggerBtn');
const triggerFeedback = document.getElementById('triggerFeedback');
const gpsStatus = document.getElementById('gpsStatus');
const gpsSub = document.getElementById('gpsSub');
const gpsCard = document.getElementById('gpsCard');
const gpsState = document.getElementById('gpsState');
const latValue = document.getElementById('latValue');
const lngValue = document.getElementById('lngValue');
const updatedValue = document.getElementById('updatedValue');
const backendValue = document.getElementById('backendValue');

const demoCard = document.getElementById('demoCard');
const demoToggle = document.getElementById('demoToggle');
const demoToggleText = document.getElementById('demoToggleText');
const simToggle = document.getElementById('simToggle');
const simToggleStatus = document.getElementById('simToggleStatus');
const simToggleDesc = document.getElementById('simToggleDesc');
const simPanelBlock = document.getElementById('simPanelBlock');
const simBadge = document.getElementById('simBadge');
const simLatEl = document.getElementById('simLat');
const simLngEl = document.getElementById('simLng');
const demoFeedback = document.getElementById('demoFeedback');
const demoCapTrigger = document.getElementById('demoCapTrigger');
const obstacleButtons = document.querySelectorAll('.obstacle-btn');

const moveButtons = {
    north: document.getElementById('moveNorth'),
    south: document.getElementById('moveSouth'),
    east: document.getElementById('moveEast'),
    west: document.getElementById('moveWest')
};

const PHONE_COORDS = { latitude: 22.3407, longitude: 73.1808 };

function formatTime(date) {
    if (!date) return '—';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

/* ── Connection status ─────────────────────────────────────── */

function setConnState(state) {
    connChip.classList.remove('active', 'reconnecting', 'error');
    connLabel.textContent = state === 'connected'
        ? 'Connected'
        : state === 'connecting'
            ? 'Connecting'
            : state === 'reconnecting'
                ? 'Reconnecting'
                : 'Disconnected';
    if (state === 'connected') {
        connChip.classList.add('active');
    } else if (state === 'reconnecting') {
        connChip.classList.add('reconnecting');
    } else if (state === 'error') {
        connChip.classList.add('error');
    }
}

/* ── Voice / TTS ───────────────────────────────────────────── */

function setVoiceState(state) {
    voiceCard.classList.remove('enabled', 'reconnecting', 'error');
    switch (state) {
        case 'enabled':
            voiceCard.classList.add('enabled');
            voiceStatus.textContent = 'Voice alerts enabled';
            voiceSub.textContent = 'Listening for obstacle alerts. They will be spoken aloud.';
            voiceBadge.classList.add('on');
            voiceBadgeText.textContent = 'On';
            break;
        case 'disabled':
            voiceBadge.classList.remove('on');
            voiceStatus.textContent = 'Voice alerts disabled';
            voiceSub.textContent = 'No alerts will be spoken. Press Enable to start listening.';
            voiceBadge.classList.remove('on');
            voiceBadgeText.textContent = 'Off';
            break;
        case 'reconnecting':
            voiceCard.classList.add('reconnecting');
            voiceStatus.textContent = 'Voice alerts enabled';
            voiceSub.textContent = 'Connection lost — reconnecting…';
            voiceBadge.classList.add('on');
            voiceBadgeText.textContent = 'On';
            break;
        case 'error':
            voiceCard.classList.add('error');
            voiceStatus.textContent = 'Connection unavailable';
            voiceSub.textContent = 'Could not reach the backend stream.';
            voiceBadge.classList.add('on');
            voiceBadgeText.textContent = 'On';
            break;
    }
}

function speak(text) {
    if (!voiceEnabled || !('speechSynthesis' in window)) {
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
}

/* ── SSE ───────────────────────────────────────────────────── */

function markSeen(alertId) {
    if (seenIds.has(alertId)) {
        return true;
    }
    seenIds.add(alertId);
    seenQueue.push(alertId);
    while (seenQueue.length > MAX_SEEN_IDS) {
        const oldest = seenQueue.shift();
        seenIds.delete(oldest);
    }
    return false;
}

function updateLastAlert(phrase, label) {
    lastAlertText.textContent = phrase;
    lastAlertMeta.textContent = `${label} · ${formatTime(new Date())}`;
    lastAlertMeta.classList.add('mono', 'muted');
    directionChip.textContent = label;
    directionChip.hidden = false;
    directionChip.classList.remove('left', 'center', 'right');
    directionChip.classList.add(label.toLowerCase());
}

function handleEventData(data) {
    let event;
    try {
        event = JSON.parse(data);
    } catch (err) {
        return;
    }
    if (!event || typeof event !== 'object' || !event.alertId) {
        return;
    }
    const phrase = DIRECTION_PHRASES[event.trigger];
    if (!phrase) {
        return;
    }
    if (markSeen(event.alertId)) {
        return;
    }
    const label = DIRECTION_LABELS[event.trigger] || event.trigger;
    updateLastAlert(phrase, label);
    speak(phrase);
}

function clearReconnectTimer() {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    clearReconnectTimer();
    if (!voiceEnabled) return;
    const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_MS);
    reconnectAttempts += 1;
    setConnState('reconnecting');
    setVoiceState('reconnecting');
    reconnectTimer = setTimeout(connect, delay);
}

function connect() {
    clearReconnectTimer();
    if (!voiceEnabled) return;
    if (connection) {
        connection.close();
        connection = null;
    }

    setConnState('connecting');

    let es;
    try {
        es = new EventSource(STREAM_ENDPOINT);
    } catch (err) {
        scheduleReconnect();
        return;
    }
    connection = es;

    es.onopen = () => {
        reconnectAttempts = 0;
        setConnState('connected');
        setVoiceState('enabled');
    };

    es.addEventListener('event', (ev) => handleEventData(ev.data));
    es.onmessage = (ev) => handleEventData(ev.data);

    es.onerror = () => {
        es.close();
        if (connection === es) {
            connection = null;
        }
        if (voiceEnabled) {
            scheduleReconnect();
        } else {
            setConnState('disconnected');
        }
    };
}

function enableVoiceAlerts() {
    if (voiceEnabled) return;
    if (!('speechSynthesis' in window)) {
        voiceCard.classList.add('error');
        voiceStatus.textContent = 'Text-to-speech not supported';
        voiceSub.textContent = 'This browser does not provide speechSynthesis.';
        return;
    }
    voiceEnabled = true;
    enableBtn.disabled = true;
    enableBtnLabel.textContent = 'Voice Alerts Enabled';
    disableBtn.disabled = false;
    setVoiceState('enabled');
    connect();
}

function disableVoiceAlerts() {
    voiceEnabled = false;
    clearReconnectTimer();
    if (connection) {
        connection.close();
        connection = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    enableBtn.disabled = false;
    enableBtnLabel.textContent = 'Enable Voice Alerts';
    disableBtn.disabled = true;
    setConnState('disconnected');
    setVoiceState('disabled');
}

/* ── Location ──────────────────────────────────────────────── */

function setGpsStatus(text, state) {
    gpsState.textContent = text;
    gpsState.classList.remove('good', 'bad', 'muted');
    gpsCard.classList.remove('live', 'error');
    switch (state) {
        case 'live':
            gpsState.classList.add('good');
            gpsCard.classList.add('live');
            break;
        case 'error':
            gpsState.classList.add('bad');
            gpsCard.classList.add('error');
            break;
        default:
            gpsState.classList.add('muted');
    }
}

function setBackendStatus(online) {
    backendOnline = online;
    backendValue.textContent = online ? 'Connected' : 'Not connected';
    backendValue.classList.remove('good', 'bad');
    backendValue.classList.add(online ? 'good' : 'bad');
}

function updatePositionDisplay(lat, lng, timestamp) {
    latValue.textContent = lat.toFixed(6);
    lngValue.textContent = lng.toFixed(6);
    updatedValue.textContent = formatTime(timestamp);
    setGpsStatus('Live · Updating', 'live');
}

function setTriggerFeedback(text, state) {
    triggerFeedback.textContent = text;
    triggerFeedback.classList.remove('ok', 'bad');
    if (state) triggerFeedback.classList.add(state);
}

function updateTriggerAvailability() {
    const hasPosition = simEnabled || lastPosition !== null;
    triggerBtn.disabled = !sharingEnabled || !hasPosition;
}

async function sendLocation(lat, lng) {
    const timestamp = new Date().toISOString();
    try {
        const response = await fetch(LOCATION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ latitude: lat, longitude: lng, timestamp })
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        updatedValue.textContent = formatTime(new Date());
        setBackendStatus(true);
        return true;
    } catch (error) {
        console.warn('[Blind Client] Failed to POST location:', error.message || error);
        setBackendStatus(false);
        return false;
    }
}

function handlePosition(position) {
    if (simEnabled) {
        return;
    }
    lastPosition = position;
    updatePositionDisplay(position.coords.latitude, position.coords.longitude, new Date(position.timestamp));
    gpsStatus.textContent = 'GPS ready';
    gpsSub.textContent = 'Your phone GPS is ready. Location is sent only when the cap trigger is activated.';
    setTriggerFeedback('Location transmitted only when the cap trigger is pressed.');
    updateTriggerAvailability();
}

function handleError(error) {
    console.warn('[Blind Client] Geolocation error:', error && error.message, '(code', error && error.code, ')');
    setGpsStatus('Unavailable', 'error');
    gpsStatus.textContent = 'Location unavailable';
    gpsSub.textContent = 'Check that location permission is allowed for this page.';
    updateTriggerAvailability();
}

function stopSharing() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    lastPosition = null;
    sharingEnabled = false;
    startBtnLabel.textContent = 'Start Sharing Location';
    startBtn.classList.remove('running');
    setGpsStatus('Stopped', 'idle');
    gpsStatus.textContent = 'Location sharing is off';
    gpsSub.textContent = 'Location sharing is off. Start to enable phone GPS.';
    setTriggerFeedback('');
    updateTriggerAvailability();
}

function startSharing() {
    if (!navigator.geolocation) {
        setGpsStatus('Unavailable', 'error');
        gpsStatus.textContent = 'GPS not supported';
        gpsSub.textContent = 'This browser does not support geolocation.';
        updateTriggerAvailability();
        return;
    }

    sharingEnabled = true;
    startBtnLabel.textContent = 'Stop Sharing Location';
    startBtn.classList.add('running');
    setGpsStatus('Waiting', 'idle');
    gpsStatus.textContent = 'Locating your phone…';
    gpsSub.textContent = 'Waiting for a GPS position. Keep this page open.';
    setTriggerFeedback('Waiting for a GPS position.');

    watchId = navigator.geolocation.watchPosition(
        handlePosition,
        handleError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );

    if (simEnabled) {
        updatePositionDisplay(simLat, simLng, new Date());
        gpsStatus.textContent = 'Simulation active';
        gpsSub.textContent = 'Simulated coordinates are the current phone location. Trigger transmits them.';
    }

    updateTriggerAvailability();
}

function toggleSharing() {
    if (sharingEnabled) {
        stopSharing();
    } else {
        startSharing();
    }
}

async function triggerCapEvent() {
    if (!sharingEnabled) {
        setTriggerFeedback('Start location sharing first.', 'bad');
        return;
    }

    let lat, lng;
    if (simEnabled) {
        lat = simLat;
        lng = simLng;
    } else if (lastPosition) {
        lat = lastPosition.coords.latitude;
        lng = lastPosition.coords.longitude;
    } else {
        setTriggerFeedback('No GPS position yet — waiting for a fix.', 'bad');
        return;
    }

    const locationOk = await sendLocation(lat, lng);
    const alertOk = await sendCapAlert(lat, lng);

    if (locationOk && alertOk) {
        setTriggerFeedback('Cap trigger sent · Alert created', 'ok');
        gpsSub.textContent = 'Cap trigger sent. Alert and current location transmitted to caretaker.';
    } else if (alertOk) {
        setTriggerFeedback('Alert created — location sync failed', 'ok');
        gpsSub.textContent = 'Cap trigger sent. Alert transmitted, but the location sync failed.';
    } else {
        setTriggerFeedback('Trigger failed — backend not reachable', 'bad');
    }
}

async function sendCapAlert(lat, lng) {
    const payload = {
        alertId: `CAP-TRIGGER-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: lat,
        longitude: lng,
        timestamp: new Date().toISOString()
    };
    try {
        const response = await fetch(EVENTS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return true;
    } catch (error) {
        console.warn('[Blind Client] Failed to POST cap-trigger event:', error.message || error);
        setBackendStatus(false);
        return false;
    }
}

/* ── Demo ──────────────────────────────────────────────────── */

function setSimEnabled(enabled) {
    simEnabled = enabled;
    simToggle.checked = enabled;
    if (simToggleStatus) {
        simToggleStatus.textContent = enabled ? 'Demo simulation: ON' : 'Demo simulation: OFF';
        simToggleStatus.classList.toggle('enabled', enabled);
    }
    if (simToggleDesc) {
        simToggleDesc.textContent = enabled
            ? 'Movement updates the local simulated position'
            : 'Simulate the phone moving';
    }
    simBadge.style.display = enabled ? 'inline-flex' : 'none';
    simPanelBlock.style.display = enabled ? '' : 'none';
    setMoveButtonsEnabled(simEnabled);

    if (enabled) {
        setTriggerFeedback('Movement stays local. Trigger transmits the simulated position.');
        if (sharingEnabled) {
            updatePositionDisplay(simLat, simLng, new Date());
            gpsStatus.textContent = 'Simulation active';
            gpsSub.textContent = 'Simulated coordinates are the current phone location. Trigger transmits them.';
        }
    } else {
        setTriggerFeedback('Movement stays local. Trigger transmits the current phone position.');
        if (sharingEnabled) {
            if (lastPosition) {
                updatePositionDisplay(lastPosition.coords.latitude, lastPosition.coords.longitude, new Date(lastPosition.timestamp));
                gpsStatus.textContent = 'GPS ready';
                gpsSub.textContent = 'Your phone GPS is ready. Location is sent only when the cap trigger is activated.';
            } else {
                setGpsStatus('Waiting', 'idle');
                gpsStatus.textContent = 'Locating your phone…';
                gpsSub.textContent = 'Waiting for a GPS position. Keep this page open.';
            }
        }
    }

    updateTriggerAvailability();
}

function setMoveButtonsEnabled(enabled) {
    Object.values(moveButtons).forEach((btn) => {
        if (btn) btn.disabled = !enabled;
    });
}

function applyMovement(dLat, dLng) {
    if (!simEnabled) return;
    simLat += dLat;
    simLng += dLng;
    simLatEl.textContent = simLat.toFixed(6);
    simLngEl.textContent = simLng.toFixed(6);
    updatePositionDisplay(simLat, simLng, new Date());
    gpsStatus.textContent = 'Simulation active';
    gpsSub.textContent = 'Movement stays local. Trigger transmits the simulated position.';
    setTriggerFeedback('Movement stays local. Trigger transmits the simulated position.');
}

function toggleDemo() {
    const open = demoCard.classList.toggle('open');
    demoToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    demoToggleText.textContent = open ? 'Hide Demo Controls' : 'Show Demo Controls';
    document.getElementById('demoToggleLabel').classList.toggle('on', open);
}

async function sendDemoEvent(direction) {
    const trigger = `OBSTACLE_${direction}`;
    const alertId = `OBSTACLE-DEMO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = {
        alertId,
        trigger,
        status: 'ACTIVE',
        heartRate: null,
        latitude: PHONE_COORDS.latitude,
        longitude: PHONE_COORDS.longitude,
        timestamp: new Date().toISOString()
    };

    demoFeedback.textContent = 'Sending event…';
    demoFeedback.classList.remove('ok', 'bad');

    try {
        const response = await fetch(EVENTS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const created = await response.json();
        demoFeedback.textContent = `${created.trigger} sent — check voice output above.`;
        demoFeedback.classList.add('ok');
    } catch (error) {
        demoFeedback.textContent = `Failed to send event: ${error.message || error}`;
        demoFeedback.classList.add('bad');
    }
}

async function checkBackend() {
    try {
        const response = await fetch(HEALTH_ENDPOINT, { headers: { 'Accept': 'application/json' } });
        setBackendStatus(response.ok);
    } catch (error) {
        setBackendStatus(false);
    }
}

startBtn.addEventListener('click', toggleSharing);
triggerBtn.addEventListener('click', triggerCapEvent);
demoCapTrigger.addEventListener('click', triggerCapEvent);

enableBtn.addEventListener('click', enableVoiceAlerts);
disableBtn.addEventListener('click', disableVoiceAlerts);

demoToggle.addEventListener('click', toggleDemo);
simToggle.addEventListener('change', (e) => setSimEnabled(e.target.checked));
moveButtons.north.addEventListener('click', () => applyMovement(MOVE_STEP, 0));
moveButtons.south.addEventListener('click', () => applyMovement(-MOVE_STEP, 0));
moveButtons.east.addEventListener('click', () => applyMovement(0, MOVE_STEP));
moveButtons.west.addEventListener('click', () => applyMovement(0, -MOVE_STEP));
obstacleButtons.forEach((btn) => {
    btn.addEventListener('click', () => sendDemoEvent(btn.getAttribute('data-direction')));
});

setVoiceState('disabled');
setConnState('disconnected');
setBackendStatus(false);
setGpsStatus('Waiting', 'idle');
simToggle.checked = false;
simPanelBlock.style.display = 'none';
setInterval(checkBackend, 10000);
checkBackend();
