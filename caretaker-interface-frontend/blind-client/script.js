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

/* ── Voice SOS state ─────────────────────────────────────── */
let sosState = 'IDLE';
let sosRecognition = null;
let sosCapturedMessage = '';
let sosSent = false;
let sosConfirmationTimer = null;
let handsFreeEnabled = false;
let passiveRestartCount = 0;
let passiveRestartTimer = null;
let buzzerState = null;

const CONFIRMATION_YES = new Set(['yes', 'send it', 'confirm', 'send emergency alert', 'send', 'ok', 'okay']);
const CONFIRMATION_NO = new Set(['no', 'cancel', 'stop', 'no cancel', 'never mind', 'nevermind']);
const WAKE_PHRASES = ['help', 'help me'];
const SOS_MAX_MESSAGE_LENGTH = 500;
const BUZZER_ENDPOINT = `${API_BASE_URL}/api/buzzer`;

const EMERGENCY_COMMAND_PHRASES = [
    'emergency',
    'i need emergency assistance',
    'i have fallen',
    'i fell',
    'need help',
    'call for help'
];

const BUZZER_ON_PHRASES = ['buzzer on', 'turn the buzzer on', 'enable buzzer', 'turn buzzer on', 'buzzer on now', 'turn on the buzzer'];
const BUZZER_OFF_PHRASES = ['buzzer off', 'turn the buzzer off', 'disable buzzer', 'turn buzzer off', 'buzzer off now', 'turn off the buzzer'];

const COMMAND_UNKNOWN_RESPONSE = 'I didn\'t understand. You can say emergency, buzzer on, or buzzer off.';

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

const micSosBtn = document.getElementById('micSosBtn');
const micSosLabel = document.getElementById('micSosLabel');
const emergencySection = document.getElementById('emergencySection');
const emergencyFeedback = document.getElementById('emergencyFeedback');
const emergencyCancelBtn = document.getElementById('emergencyCancelBtn');
const confirmationCard = document.getElementById('confirmationCard');
const confirmationMessage = document.getElementById('confirmationMessage');
const confirmSendBtn = document.getElementById('confirmSendBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');
const confirmFeedback = document.getElementById('confirmFeedback');
const handsfreeCard = document.getElementById('handsfreeCard');
const handsfreeToggle = document.getElementById('handsfreeToggle');
const handsfreeStatus = document.getElementById('handsfreeStatus');
const handsfreeHint = document.getElementById('handsfreeHint');
const buzzerStateEl = document.getElementById('buzzerState');
const buzzerStateText = document.getElementById('buzzerStateText');

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

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, (c) => map[c]);
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

function speak(text, onDone) {
    if (!voiceEnabled || !('speechSynthesis' in window)) {
        if (onDone) onDone();
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    if (onDone) {
        utterance.onend = () => onDone();
        utterance.onerror = () => onDone();
    }
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
    if (isInEmergencyConversation()) {
        return;
    }
    const label = DIRECTION_LABELS[event.trigger] || event.trigger;
    updateLastAlert(phrase, label);
    speak(phrase);
}

function isInEmergencyConversation() {
    return sosState === 'COMMAND_LISTENING' ||
        sosState === 'LISTENING_FOR_EMERGENCY' ||
        sosState === 'CONFIRMING_MESSAGE' ||
        sosState === 'SENDING_SOS' ||
        sosState === 'SUCCESS' ||
        sosState === 'ERROR' ||
        sosState === 'CANCELLED';
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

/* ── Voice SOS — Mic button toggle ───────────────────────── */

function speechRecognitionAvailable() {
    return ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
}

function toggleMicSos() {
    if (sosState !== 'IDLE' && sosState !== 'PASSIVE_LISTENING') {
        stopVoiceCapture();
        return;
    }
    if (!speechRecognitionAvailable()) {
        setEmergencyFeedback('Speech recognition is not supported in this browser. Try Chrome or Edge on mobile.', false);
        emergencySection.classList.add('active');
        return;
    }
    stopPassiveListening();
    startVoiceCapture();
}

function setEmergencyFeedback(text, isListening) {
    emergencyFeedback.textContent = text;
    emergencyFeedback.classList.remove('listening-state');
    if (isListening) {
        emergencyFeedback.classList.add('listening-state');
    }
}

function setMicListening(isListening) {
    micSosBtn.classList.toggle('listening', isListening);
    micSosLabel.textContent = isListening ? 'Listening… Press to stop' : 'Emergency SOS — Voice';
}

/* ── Hands-free passive listening ────────────────────────── */

function updateHandsfreeUI() {
    if (!handsfreeCard || !handsfreeStatus || !handsfreeHint) return;
    if (!handsFreeEnabled) {
        handsfreeCard.classList.remove('active');
        handsfreeStatus.textContent = 'Hands-free listening off';
        handsfreeStatus.classList.remove('listening');
        handsfreeHint.textContent = 'Enable to listen for "Help" to control the device by voice. Emergency SOS is only sent after you confirm.';
        return;
    }
    if (sosState === 'PASSIVE_LISTENING') {
        handsfreeCard.classList.add('active');
        handsfreeStatus.textContent = 'Hands-free listening';
        handsfreeStatus.classList.add('listening');
        handsfreeHint.textContent = 'Say "Help" to control the buzzer or request emergency assistance.';
    } else if (sosState === 'COMMAND_LISTENING') {
        handsfreeCard.classList.add('active');
        handsfreeStatus.textContent = 'Listening for command';
        handsfreeStatus.classList.add('listening');
        handsfreeHint.textContent = 'Emergency \u2022 Buzzer on \u2022 Buzzer off';
    } else if (sosState === 'EXECUTING_COMMAND') {
        handsfreeCard.classList.add('active');
        handsfreeStatus.textContent = 'Sending command to device';
        handsfreeStatus.classList.remove('listening');
        handsfreeHint.textContent = 'Waiting for the device to confirm.';
    } else {
        handsfreeCard.classList.add('active');
        handsfreeStatus.textContent = 'Hands-free active';
        handsfreeStatus.classList.remove('listening');
        handsfreeHint.textContent = 'Listening is paused during the conversation.';
    }
}

function stopPassiveListening() {
    clearTimeout(passiveRestartTimer);
    passiveRestartTimer = null;
    passiveRestartCount = 0;
    if (sosState === 'PASSIVE_LISTENING' || sosState === 'COMMAND_LISTENING' || sosState === 'EXECUTING_COMMAND') {
        stopRecognition();
        sosState = 'IDLE';
    }
    updateHandsfreeUI();
}

function startPassiveListening() {
    if (!handsFreeEnabled) return;
    if (!speechRecognitionAvailable()) {
        setHandsfreeDenied('Speech recognition is not supported in this browser.');
        return;
    }
    if (!sosRecognition) {
        sosState = 'PASSIVE_LISTENING';
        startRecognition('passive');
    } else {
        sosState = 'PASSIVE_LISTENING';
    }
    updateHandsfreeUI();
}

function setHandsfreeDenied(text) {
    handsFreeEnabled = false;
    if (handsfreeToggle) handsfreeToggle.checked = false;
    if (handsfreeStatus) {
        handsfreeStatus.textContent = 'Microphone access required';
        handsfreeStatus.classList.remove('listening');
    }
    if (handsfreeHint) handsfreeHint.textContent = text + ' Microphone access is required for hands-free emergency activation. The manual Emergency SOS button still works.';
    if (handsfreeCard) handsfreeCard.classList.remove('active');
}

function enableHandsFree() {
    if (!speechRecognitionAvailable()) {
        setHandsfreeDenied('Speech recognition is not supported in this browser.');
        return;
    }
    handsFreeEnabled = true;
    if (sosState === 'IDLE') {
        startPassiveListening();
    } else {
        updateHandsfreeUI();
    }
}

function disableHandsFree() {
    handsFreeEnabled = false;
    stopPassiveListening();
    if (sosState === 'IDLE') {
        updateHandsfreeUI();
    }
}

function toggleHandsFree() {
    if (handsfreeToggle.checked) {
        enableHandsFree();
    } else {
        disableHandsFree();
    }
}

/* ── Voice SOS — State machine ───────────────────────────── */

function startVoiceCapture() {
    sosState = 'LISTENING_FOR_EMERGENCY';
    sosCapturedMessage = '';
    sosSent = false;
    if (sosConfirmationTimer) {
        clearTimeout(sosConfirmationTimer);
        sosConfirmationTimer = null;
    }
    emergencySection.classList.add('active');
    confirmationCard.classList.remove('active');
    setEmergencyFeedback('I\'m listening. Please tell me what happened.', true);
    setMicListening(true);
    updateHandsfreeUI();

    const prompt = 'I\'m listening. Please tell me what happened.';
    speak(prompt, () => {
        if (sosState === 'LISTENING_FOR_EMERGENCY') {
            startRecognition('capture');
        }
    });
}

/* ── Voice command listening (wake → command) ──────────── */

function startCommandListening() {
    sosState = 'COMMAND_LISTENING';
    sosCapturedMessage = '';
    sosSent = false;
    if (sosConfirmationTimer) {
        clearTimeout(sosConfirmationTimer);
        sosConfirmationTimer = null;
    }
    emergencySection.classList.remove('active');
    confirmationCard.classList.remove('active');
    updateHandsfreeUI();

    const prompt = 'What would you like to do? Say emergency, buzzer on, or buzzer off.';
    speak(prompt, () => {
        if (sosState === 'COMMAND_LISTENING') {
            startRecognition('command');
        }
    });
}

function recognizeCommand(text) {
    const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();

    for (const phrase of EMERGENCY_COMMAND_PHRASES) {
        if (lower.includes(phrase)) {
            return 'EMERGENCY';
        }
    }

    for (const phrase of BUZZER_ON_PHRASES) {
        if (lower.includes(phrase)) {
            return 'BUZZER_ON';
        }
    }

    for (const phrase of BUZZER_OFF_PHRASES) {
        if (lower.includes(phrase)) {
            return 'BUZZER_OFF';
        }
    }

    return 'UNKNOWN';
}

function handleCommandResult(finalTranscript, interimTranscript) {
    if (!finalTranscript) return;

    if (finalTranscript.toLowerCase().includes('cancel') ||
        finalTranscript.toLowerCase().includes('never mind') ||
        finalTranscript.toLowerCase().includes('stop')) {
        returnToPassive();
        return;
    }

    const command = recognizeCommand(finalTranscript);

    switch (command) {
        case 'EMERGENCY':
            stopRecognition();
            startVoiceCapture();
            break;
        case 'BUZZER_ON':
        case 'BUZZER_OFF':
            stopRecognition();
            sosState = 'EXECUTING_COMMAND';
            updateHandsfreeUI();
            executeBuzzerCommand(command);
            break;
        default:
            stopRecognition();
            sosState = 'COMMAND_LISTENING';
            updateHandsfreeUI();
            speak(COMMAND_UNKNOWN_RESPONSE, () => {
                if (sosState === 'COMMAND_LISTENING' && handsFreeEnabled) {
                    startRecognition('command');
                }
            });
    }
}

async function executeBuzzerCommand(command) {
    const commandName = command === 'BUZZER_ON' ? 'BUZZER_ON' : 'BUZZER_OFF';
    const desiredOn = command === 'BUZZER_ON';
    let succeeded = false;

    try {
        const response = await fetch(BUZZER_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ command: commandName })
        });
        if (response.ok) {
            const result = await response.json();
            buzzerState = result.state || (desiredOn ? 'ON' : 'OFF');
            updateBuzzerStateUI();
            succeeded = true;
        } else {
            console.warn('[Voice Command] Buzzer endpoint rejected:', response.status);
        }
    } catch (error) {
        console.warn('[Voice Command] Failed to send buzzer command:', error.message || error);
        setBackendStatus(false);
    }

    if (succeeded) {
        const text = desiredOn ? 'Buzzer turned on.' : 'Buzzer turned off.';
        speak(text, () => {
            returnToPassive();
        });
    } else {
        speak('I could not reach the device to change the buzzer. Please try again.', () => {
            returnToPassive();
        });
    }
}

function returnToPassive() {
    stopRecognition();
    if (handsFreeEnabled) {
        startPassiveListening();
    } else {
        sosState = 'IDLE';
        updateHandsfreeUI();
    }
}

function updateBuzzerStateUI() {
    if (!buzzerStateEl || !buzzerStateText) return;
    if (buzzerState === null) {
        buzzerStateEl.hidden = true;
        return;
    }
    buzzerStateEl.hidden = false;
    const isOn = buzzerState === 'ON';
    buzzerStateText.textContent = isOn ? 'Buzzer: On' : 'Buzzer: Off';
    buzzerStateEl.classList.toggle('on', isOn);
    buzzerStateEl.classList.toggle('off', !isOn);
}

async function fetchBuzzerState() {
    try {
        const response = await fetch(BUZZER_ENDPOINT, { headers: { 'Accept': 'application/json' } });
        if (response.ok) {
            const result = await response.json();
            buzzerState = result.state;
            updateBuzzerStateUI();
        }
    } catch (error) {
        console.warn('[Blind Client] Failed to fetch buzzer state:', error.message || error);
    }
}

function setSosState(newState) {
    sosState = newState;
    updateHandsfreeUI();
}

function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    return recognition;
}

function shouldDeclareWake(transcript) {
    const lower = transcript.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
    for (const phrase of WAKE_PHRASES) {
        if (lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase) || lower.includes(' ' + phrase + ' ') || lower.includes(phrase + '.')) {
            return true;
        }
    }
    return false;
}

function startRecognition(mode) {
    stopRecognition(false);
    const recognition = initRecognition();
    if (!recognition) {
        if (mode === 'capture') {
            setEmergencyFeedback('Speech recognition unavailable. Please try again.', false);
        } else if (mode === 'passive') {
            setHandsfreeDenied('Speech recognition is not supported in this browser.');
            return;
        }
        sosState = 'IDLE';
        setMicListening(false);
        updateHandsfreeUI();
        return;
    }

    sosRecognition = recognition;

    recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }

        if (mode === 'passive') {
            handlePassiveResult(finalTranscript, interimTranscript);
        } else if (mode === 'command') {
            handleCommandResult(finalTranscript, interimTranscript);
        } else if (mode === 'capture') {
            handleCaptureResult(finalTranscript, interimTranscript);
        } else if (mode === 'confirm') {
            handleConfirmResult(finalTranscript);
        }
    };

    recognition.onend = () => {
        sosRecognition = null;
        if (mode === 'passive' && sosState === 'PASSIVE_LISTENING' && handsFreeEnabled) {
            schedulePassiveRestart();
        } else if (mode === 'command' && (sosState === 'COMMAND_LISTENING' || sosState === 'EXECUTING_COMMAND')) {
            try { restartRecognitionIfNeeded(recognition); } catch (e) { /* already started */ }
        } else if (mode === 'capture' && sosState === 'LISTENING_FOR_EMERGENCY') {
            try { restartRecognitionIfNeeded(recognition); } catch (e) { /* already started */ }
        } else if (mode === 'confirm' && sosState === 'CONFIRMING_MESSAGE') {
            try { restartRecognitionIfNeeded(recognition); } catch (e) { /* already started */ }
        }
    };

    recognition.onerror = (event) => {
        if (event.error === 'no-speech') return;
        if (event.error === 'aborted') return;
        console.warn('[Voice SOS] Recognition error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            if (mode === 'passive') {
                setHandsfreeDenied('Microphone access denied.');
            } else if (mode === 'command') {
                sosState = 'IDLE';
                updateHandsfreeUI();
            } else {
                setEmergencyFeedback('Microphone access denied. Please allow microphone and try again.', false);
                setMicListening(false);
                stopPassiveListening();
                sosState = 'IDLE';
            }
        }
    };

    try {
        recognition.start();
    } catch (e) {
        console.warn('[Voice SOS] Failed to start recognition:', e);
        if (mode === 'passive') {
            setHandsfreeDenied('Microphone access error.');
        } else {
            sosState = 'IDLE';
            setMicListening(false);
        }
    }
}

function restartRecognitionIfNeeded(recognition) {
    if (sosRecognition === recognition) {
        recognition.start();
    }
}

function schedulePassiveRestart() {
    clearTimeout(passiveRestartTimer);
    if (!handsFreeEnabled || sosState !== 'PASSIVE_LISTENING') return;
    if (passiveRestartCount > 4) {
        passiveRestartCount = 0;
        passiveRestartTimer = setTimeout(() => {
            passiveRestartCount = 0;
            if (handsFreeEnabled && sosState === 'PASSIVE_LISTENING') startRecognition('passive');
        }, 3000);
        return;
    }
    passiveRestartCount += 1;
    passiveRestartTimer = setTimeout(() => {
        if (handsFreeEnabled && sosState === 'PASSIVE_LISTENING') startRecognition('passive');
    }, 600);
}

function handlePassiveResult(finalTranscript, interimTranscript) {
    if (finalTranscript && shouldDeclareWake(finalTranscript)) {
        stopRecognition();
        startCommandListening();
    }
}

function stopRecognition(resetState) {
    clearTimeout(passiveRestartTimer);
    passiveRestartTimer = null;
    passiveRestartCount = 0;
    if (sosRecognition) {
        try { sosRecognition.abort(); } catch (e) { /* ignore */ }
        sosRecognition = null;
    }
    if (resetState !== false) {
        setMicListening(false);
    }
}

function handleCaptureResult(finalTranscript, interimTranscript) {
    if (finalTranscript) {
        const lower = finalTranscript.toLowerCase().trim();
        if (lower.includes('done') || lower.includes('finished') || lower.includes('that\'s it') || lower.includes('send')) {
            if (sosCapturedMessage.trim()) {
                transitionToConfirm();
                return;
            }
        }
        if (lower.includes('cancel') || lower.includes('never mind') || lower.includes('stop')) {
            stopVoiceCapture();
            return;
        }
        sosCapturedMessage += (sosCapturedMessage ? ' ' : '') + finalTranscript;
    }
    const displayText = sosCapturedMessage + (interimTranscript ? ' ' + interimTranscript : '');
    if (displayText.trim()) {
        setEmergencyFeedback('Capturing: "' + displayText.trim() + '"', true);
    } else {
        setEmergencyFeedback('I\'m listening. Please tell me what happened.', true);
    }
}

function transitionToConfirm() {
    stopRecognition();
    sosState = 'CONFIRMING_MESSAGE';
    emergencySection.classList.remove('active');
    confirmationCard.classList.add('active');
    confirmationMessage.textContent = sosCapturedMessage;
    confirmSendBtn.disabled = true;
    confirmFeedback.textContent = 'Say "yes" / "send it" to confirm, or "no" / "cancel" to cancel.';
    confirmFeedback.classList.remove('ok', 'bad');
    updateHandsfreeUI();
    speak('You said: ' + sosCapturedMessage + '. Should I send an emergency alert?', () => {
        if (sosState === 'CONFIRMING_MESSAGE') {
            confirmSendBtn.disabled = false;
            startRecognition('confirm');
        }
    });
    sosConfirmationTimer = setTimeout(() => {
        if (sosState === 'CONFIRMING_MESSAGE') {
            setConfirmFeedback('No response received. Emergency alert cancelled.', true);
            setTimeout(() => abortVoiceSos(), 2000);
        }
    }, 15000);
}

function handleConfirmResult(transcript) {
    if (!transcript) return;
    const lower = transcript.toLowerCase().trim();
    let confirmed = false;
    let cancelled = false;

    for (const phrase of CONFIRMATION_YES) {
        if (lower.includes(phrase)) {
            confirmed = true;
            break;
        }
    }

    if (!confirmed) {
        for (const phrase of CONFIRMATION_NO) {
            if (lower.includes(phrase)) {
                cancelled = true;
                break;
            }
        }
    }

    if (confirmed) {
        transitionToSend();
    } else if (cancelled) {
        abortVoiceSos();
    }
}

function setConfirmFeedback(text, isCancel) {
    confirmFeedback.textContent = text;
    confirmFeedback.classList.remove('ok', 'bad');
    confirmFeedback.classList.add(isCancel ? 'bad' : 'ok');
}

function transitionToSend() {
    stopRecognition();
    sosState = 'SENDING_SOS';
    confirmSendBtn.disabled = true;
    if (sosConfirmationTimer) {
        clearTimeout(sosConfirmationTimer);
        sosConfirmationTimer = null;
    }
    setConfirmFeedback('Sending emergency alert...', false);
    sendSosAlert();
}

async function sendSosAlert() {
    if (sosSent) return;
    sosSent = true;

    let lat, lng;
    if (simEnabled) {
        lat = simLat;
        lng = simLng;
    } else if (lastPosition) {
        lat = lastPosition.coords.latitude;
        lng = lastPosition.coords.longitude;
    } else {
        try {
            const pos = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 8000,
                    maximumAge: 10000
                });
            });
            lat = pos.coords.latitude;
            lng = pos.coords.longitude;
        } catch (e) {
            lat = PHONE_COORDS.latitude;
            lng = PHONE_COORDS.longitude;
        }
    }

    const locationOk = await sendLocation(lat, lng);
    const alertId = `VOICE-SOS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = {
        alertId,
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: lat,
        longitude: lng,
        message: sosCapturedMessage,
        timestamp: new Date().toISOString()
    };

    let alertOk = false;
    try {
        const response = await fetch(EVENTS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        });
        alertOk = response.ok;
        if (!alertOk) {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.warn('[Voice SOS] Failed to POST SOS event:', error.message || error);
    }

    if (alertOk) {
        sosState = 'SUCCESS';
        if (locationOk) {
            setConfirmFeedback('Emergency alert activated. Your location and message have been sent.', false);
            speak('Emergency alert activated. Your location and message have been sent.', () => {
                setTimeout(() => resetVoiceSos(), 2000);
            });
        } else {
            setConfirmFeedback('Emergency alert sent. Location sync failed but your message was delivered.', false);
            speak('Emergency alert sent. Location sync failed but your message was delivered.', () => {
                setTimeout(() => resetVoiceSos(), 2000);
            });
        }
    } else {
        sosState = 'ERROR';
        setConfirmFeedback('I could not send the emergency alert. Please try again.', true);
        speak('I could not send the emergency alert. Please try again.', () => {
            setTimeout(() => resetVoiceSos(), 2000);
        });
    }
}

function abortVoiceSos() {
    stopRecognition();
    if (sosConfirmationTimer) {
        clearTimeout(sosConfirmationTimer);
        sosConfirmationTimer = null;
    }
    sosState = 'CANCELLED';
    confirmationCard.classList.remove('active');
    emergencySection.classList.remove('active');
    setMicListening(false);
    speak('Emergency alert was cancelled.', () => {
        setTimeout(() => resetVoiceSos(), 1000);
    });
}

function stopVoiceCapture() {
    stopRecognition();
    if (sosConfirmationTimer) {
        clearTimeout(sosConfirmationTimer);
        sosConfirmationTimer = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    sosState = 'IDLE';
    sosCapturedMessage = '';
    sosSent = false;
    emergencySection.classList.remove('active');
    confirmationCard.classList.remove('active');
    setMicListening(false);
    updateHandsfreeUI();
}

function resetVoiceSos() {
    sosState = 'IDLE';
    sosCapturedMessage = '';
    sosSent = false;
    sosRecognition = null;
    sosConfirmationTimer = null;
    emergencySection.classList.remove('active');
    confirmationCard.classList.remove('active');
    setMicListening(false);
    if (handsFreeEnabled) {
        startPassiveListening();
    } else {
        updateHandsfreeUI();
    }
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
    fetchBuzzerState();
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

micSosBtn.addEventListener('click', toggleMicSos);
emergencyCancelBtn.addEventListener('click', stopVoiceCapture);
confirmSendBtn.addEventListener('click', transitionToSend);
confirmCancelBtn.addEventListener('click', abortVoiceSos);
handsfreeToggle.addEventListener('change', toggleHandsFree);

setVoiceState('disabled');
setConnState('disconnected');
setBackendStatus(false);
setGpsStatus('Waiting', 'idle');
simToggle.checked = false;
simPanelBlock.style.display = 'none';
setInterval(checkBackend, 10000);
updateBuzzerStateUI();
checkBackend();
