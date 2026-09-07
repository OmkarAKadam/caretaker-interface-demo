const API_BASE_URL =
    (typeof window !== 'undefined' && window.API_BASE_URL) ||
    'http://localhost:3000';
const EVENTS_ENDPOINT = `${API_BASE_URL}/api/events`;
const STREAM_ENDPOINT = `${API_BASE_URL}/api/events/stream`;

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

const MAX_SEEN_IDS = 50;
const BASE_RECONNECT_MS = 1500;
const MAX_RECONNECT_MS = 20000;

let enabled = false;
let connection = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

const seenIds = new Set();
const seenQueue = [];

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

const demoCard = document.getElementById('demoCard');
const demoToggle = document.getElementById('demoToggle');
const demoToggleText = document.getElementById('demoToggleText');
const demoFeedback = document.getElementById('demoFeedback');
const obstacleButtons = document.querySelectorAll('.obstacle-btn');

const PHONE_COORDS = { latitude: 22.3407, longitude: 73.1808 };

function formatTime(date) {
    if (!date) return '—';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

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

function speak(text) {
    if (!enabled || !('speechSynthesis' in window)) {
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
}

function updateLastAlert(phrase, label, alertId) {
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
    updateLastAlert(phrase, label, event.alertId);
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
    if (!enabled) return;
    const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_MS);
    reconnectAttempts += 1;
    setConnState('reconnecting');
    setVoiceState('reconnecting');
    reconnectTimer = setTimeout(connect, delay);
}

function connect() {
    clearReconnectTimer();
    if (!enabled) return;
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
        if (enabled) {
            scheduleReconnect();
        } else {
            setConnState('disconnected');
        }
    };
}

function enableVoiceAlerts() {
    if (enabled) return;
    if (!('speechSynthesis' in window)) {
        voiceCard.classList.add('error');
        voiceStatus.textContent = 'Text-to-speech not supported';
        voiceSub.textContent = 'This browser does not provide speechSynthesis.';
        return;
    }
    enabled = true;
    enableBtn.disabled = true;
    enableBtnLabel.textContent = 'Voice Alerts Enabled';
    disableBtn.disabled = false;
    setVoiceState('enabled');
    connect();
}

function disableVoiceAlerts() {
    enabled = false;
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

enableBtn.addEventListener('click', enableVoiceAlerts);
disableBtn.addEventListener('click', disableVoiceAlerts);
demoToggle.addEventListener('click', toggleDemo);
obstacleButtons.forEach((btn) => {
    btn.addEventListener('click', () => sendDemoEvent(btn.getAttribute('data-direction')));
});

setVoiceState('disabled');
setConnState('disconnected');