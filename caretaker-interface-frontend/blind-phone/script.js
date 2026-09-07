const API_BASE_URL =
    (typeof window !== 'undefined' && window.API_BASE_URL) ||
    'http://localhost:3000';
const LOCATION_ENDPOINT = `${API_BASE_URL}/api/location`;
const HEALTH_ENDPOINT = `${API_BASE_URL}/api/health`;

const MOVE_STEP = 0.0005;

let sharingEnabled = false;
let watchId = null;
let lastPosition = null;
let lastSentAt = null;
let backendOnline = false;

let simEnabled = false;
let simLat = 22.3407;
let simLng = 73.1808;

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
const modeChip = document.getElementById('modeChip');
const modeLabel = document.getElementById('modeLabel');

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
const moveButtons = {
    north: document.getElementById('moveNorth'),
    south: document.getElementById('moveSouth'),
    east: document.getElementById('moveEast'),
    west: document.getElementById('moveWest')
};

function formatTime(date) {
    if (!date) return '—';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function setMode(active) {
    sharingEnabled = active;
    modeChip.classList.toggle('active', active);
    modeLabel.textContent = active ? 'Sharing' : 'Not sharing';
    startBtnLabel.textContent = active ? 'Stop Sharing Location' : 'Start Sharing Location';
    startBtn.classList.toggle('running', active);
}

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
        lastSentAt = new Date();
        updatedValue.textContent = formatTime(lastSentAt);
        setBackendStatus(true);
        return true;
    } catch (error) {
        console.warn('[GPS Client] Failed to POST location:', error.message || error);
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
    console.warn('[GPS Client] Geolocation error:', error && error.message, '(code', error && error.code, ')');
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
    setMode(false);
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

    setMode(true);
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

    const ok = await sendLocation(lat, lng);
    if (ok) {
        setTriggerFeedback('Trigger sent · Location transmitted', 'ok');
        gpsSub.textContent = 'Cap trigger sent. Current location transmitted to caretaker.';
    } else {
        setTriggerFeedback('Trigger failed — backend not reachable', 'bad');
    }
}

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
demoToggle.addEventListener('click', toggleDemo);
simToggle.addEventListener('change', (e) => setSimEnabled(e.target.checked));
moveButtons.north.addEventListener('click', () => applyMovement(MOVE_STEP, 0));
moveButtons.south.addEventListener('click', () => applyMovement(-MOVE_STEP, 0));
moveButtons.east.addEventListener('click', () => applyMovement(0, MOVE_STEP));
moveButtons.west.addEventListener('click', () => applyMovement(0, -MOVE_STEP));

setBackendStatus(false);
setGpsStatus('Waiting', 'idle');
simToggle.checked = false;
simPanelBlock.style.display = 'none';
setInterval(checkBackend, 10000);
checkBackend();