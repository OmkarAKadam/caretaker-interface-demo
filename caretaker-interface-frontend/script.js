let heartRateEnabled = true;
let alertCounter = 6;
let map = null;
let userMarker = null;
let currentAlert = null;
const alertsById = new Map();
let selectedAlertId = null;
let simulationTimer = null;
let isSimulationRunning = false;
let baseLatitude = 22.3072;
let baseLongitude = 73.1812;
const MAX_HISTORY_ENTRIES = 30;
const API_BASE_URL = (typeof window !== 'undefined' && window.API_BASE_URL) || 'http://localhost:3000';
const EVENTS_ENDPOINT = `${API_BASE_URL}/api/events`;
const LOCATION_ENDPOINT = `${API_BASE_URL}/api/location`;
const API_POLL_INTERVAL = 5000;
const LOCATION_POLL_INTERVAL = 5000;
let apiPollingTimer = null;
let isApiPollingRunning = false;
let apiPollingEpoch = 0;
let apiStatus = 'unknown';
let locationPollingTimer = null;
let isLocationPollingRunning = false;
let locationPollingEpoch = 0;
let currentLocation = {
    latitude: null,
    longitude: null,
    timestamp: null
};
const processedAlertIds = new Set();

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="28" height="28"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="28" height="28"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="28" height="28"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>';

function initMap(latitude, longitude) {
    if (map) return;
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;

    try {
        map = L.map('map', {
            center: [latitude, longitude],
            zoom: 16,
            zoomControl: true,
            attributionControl: true
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        }).addTo(map);

        const userIcon = L.divIcon({
            className: 'st-pin',
            html: '<span class="marker-pin"><span class="pin-core"></span><span class="pin-dot"><i></i></span></span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        userMarker = L.marker([latitude, longitude], { icon: userIcon }).addTo(map);
        updateMarkerPopup(null);

        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (map) {
                    requestAnimationFrame(() => map.invalidateSize());
                }
            }, 120);
        });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (map) map.invalidateSize();
            });
        });
    } catch (error) {
        const errBox = document.getElementById('mapUnavailable');
        if (errBox) errBox.classList.add('visible');
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.style.display = 'none';
        console.warn('[Map] Initialization failed:', error);
    }
}

function updateMarkerPopup(alertId) {
    if (!userMarker) return;
    userMarker.bindPopup(
        `<strong>Selected location</strong><br>` +
        `Lat: ${userMarker.getLatLng().lat.toFixed(4)}<br>` +
        `Lng: ${userMarker.getLatLng().lng.toFixed(4)}` +
        (alertId ? `<br><b>${alertId}</b>` : '')
    );
}

function updateMapLocation(latitude, longitude, alertId) {
    if (!map || !userMarker) {
        initMap(latitude, longitude);
        return;
    }
    userMarker.setLatLng([latitude, longitude]);
    updateMarkerPopup(alertId);
    map.panTo([latitude, longitude], { animate: true });
}

function isValidLocation(latitude, longitude) {
    return typeof latitude === 'number' && isFinite(latitude) &&
           typeof longitude === 'number' && isFinite(longitude) &&
           latitude >= -90 && latitude <= 90 &&
           longitude >= -180 && longitude <= 180;
}

function handleLocationUpdate(latitude, longitude, timestamp) {
    if (!isValidLocation(latitude, longitude)) {
        console.warn(`[Location] Ignored invalid location: lat=${latitude}, lng=${longitude}.`);
        return;
    }

    currentLocation = {
        latitude,
        longitude,
        timestamp: timestamp || null
    };

    const latitudeEl = document.getElementById('latitude');
    const longitudeEl = document.getElementById('longitude');
    if (latitudeEl) latitudeEl.textContent = latitude.toFixed(4);
    if (longitudeEl) longitudeEl.textContent = longitude.toFixed(4);

    const locationTimestampEl = document.getElementById('locationTimestamp');
    if (locationTimestampEl && currentLocation.timestamp) {
        locationTimestampEl.textContent = formatTime(currentLocation.timestamp);
    }

    const srcEl = document.getElementById('locationSource');
    if (srcEl) srcEl.textContent = 'Phone GPS';
    const srcFooterEl = document.getElementById('locationSourceFooter');
    if (srcFooterEl) srcFooterEl.textContent = 'Phone GPS (mobile location)';

    updateMapLocation(latitude, longitude, null);
}

function generateAlertId() {
    return `ALT-${String(alertCounter++).padStart(3, '0')}`;
}

function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function getTriggerClass(trigger) {
    if (trigger === 'SOS' || trigger === 'SOS_AND_HEART_RATE') return 'sos';
    if (trigger === 'HEART_RATE') return 'heart-rate';
    return '';
}

function getTriggerLabel(trigger) {
    const labels = {
        'SOS': 'Manual SOS',
        'HEART_RATE': 'Abnormal Heart Rate',
        'SOS_AND_HEART_RATE': 'SOS + Abnormal Heart Rate'
    };
    return labels[trigger] || trigger;
}

function getHeartRateDisplay(heartRate) {
    return heartRate !== null && heartRate !== undefined ? `${heartRate} BPM` : '—';
}

function getLocationDisplay(latitude, longitude) {
    return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function getSeverityKey(trigger) {
    if (trigger === 'HEART_RATE') return 'warning';
    if (trigger === 'SOS' || trigger === 'SOS_AND_HEART_RATE') return 'emergency';
    return 'normal';
}

function getSourceLabel(source) {
    const map = { 'AUTO SIM': 'Auto Simulation', 'DEMO': 'Demo', 'API': 'API', 'PHONE': 'Phone GPS' };
    return map[source] || source || '—';
}

function getStatusClass(status) {
    switch (status) {
        case 'ACTIVE': return 'active';
        case 'ACKNOWLEDGED': return 'acknowledged';
        case 'RESOLVED': return 'resolved';
        case 'NORMAL': return 'resolved';
        default: return 'active';
    }
}

function getStatusLabel(status) {
    switch (status) {
        case 'ACTIVE': return 'Active';
        case 'ACKNOWLEDGED': return 'Acknowledged';
        case 'RESOLVED': return 'Resolved';
        case 'NORMAL': return 'Normal';
        default: return status;
    }
}

function getDetailStatusClass(status) {
    switch (status) {
        case 'ACTIVE': return 'status-active';
        case 'ACKNOWLEDGED': return 'status-acknowledged';
        case 'RESOLVED': return 'status-resolved';
        case 'NORMAL': return 'status-resolved';
        default: return 'status-active';
    }
}

function getMetaStatusClass(status) {
    switch (status) {
        case 'ACTIVE': return 'status-active';
        case 'ACKNOWLEDGED': return 'status-acknowledged';
        case 'RESOLVED': return 'status-resolved';
        case 'NORMAL': return 'status-resolved';
        default: return 'status-active';
    }
}

function createHistoryRow(event) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.alertId = event.alertId;
    item.dataset.sev = getSeverityKey(event.trigger);

    const triggerClass = getTriggerClass(event.trigger);
    const triggerLabel = getTriggerLabel(event.trigger);
    const statusClass = getStatusClass(event.status);
    const statusLabel = getStatusLabel(event.status);
    const hrDisplay = getHeartRateDisplay(event.heartRate);
    const sourceLabel = getSourceLabel(event.source || 'API');

    item.innerHTML = `
        <div class="history-rail"><span class="history-dot"></span></div>
        <div class="history-main">
            <div class="history-headline">
                <span class="history-trigger ${triggerClass}">${triggerLabel}</span>
                <span class="history-alert-id">${event.alertId}</span>
            </div>
            <div class="history-meta">
                <span class="history-time">${formatTime(event.timestamp)}</span>
                <span class="history-meta-sep">·</span>
                <span class="history-heart-rate">${hrDisplay}</span>
                <span class="history-meta-sep">·</span>
                <span class="history-location">${getLocationDisplay(event.latitude, event.longitude)}</span>
                <span class="history-source">${sourceLabel}</span>
            </div>
        </div>
        <div class="history-side">
            <span class="history-status ${statusClass}"><span class="dot"></span>${statusLabel}</span>
        </div>
        <span class="history-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 6 15 12 9 18"></polyline></svg></span>
    `;
    return item;
}

function addToHistory(event) {
    const list = document.getElementById('alertHistoryList');
    if (!list) return;
    const item = createHistoryRow(event);
    item.classList.add('is-new');
    list.insertBefore(item, list.firstChild);
    setTimeout(() => item.classList.remove('is-new'), 600);
    trimHistory();
    updateHistoryEmptyState();
}

function updateHistoryRow(alertId, newStatus) {
    const items = document.querySelectorAll('#alertHistoryList .history-item');
    items.forEach(row => {
        if (row.dataset.alertId === alertId) {
            const statusEl = row.querySelector('.history-status');
            if (statusEl) {
                const statusClass = getStatusClass(newStatus);
                const statusLabel = getStatusLabel(newStatus);
                statusEl.className = `history-status ${statusClass}`;
                statusEl.innerHTML = `<span class="dot"></span>${statusLabel}`;
            }
        }
    });
}

function updateHistoryEmptyState() {
    const list = document.getElementById('alertHistoryList');
    const empty = document.getElementById('alertHistoryEmpty');
    const countEl = document.getElementById('historyCount');
    if (!list || !empty) return;
    const count = list.querySelectorAll('.history-item').length;
    empty.classList.toggle('visible', count === 0);
    if (countEl) countEl.textContent = `${count} alert${count === 1 ? '' : 's'}`;
}

function updateActionButtons(status) {
    const acknowledgeBtn = document.getElementById('acknowledgeBtn');
    const resolveBtn = document.getElementById('resolveBtn');
    const heroAckBtn = document.getElementById('heroAckBtn');
    const heroResolveBtn = document.getElementById('heroResolveBtn');
    const actionNote = document.getElementById('actionNote');
    const heroActions = document.getElementById('heroActions');

    if (!currentAlert || status === 'NORMAL' || status === 'RESOLVED') {
        acknowledgeBtn.disabled = true;
        resolveBtn.disabled = true;
        if (heroAckBtn) heroAckBtn.disabled = true;
        if (heroResolveBtn) heroResolveBtn.disabled = true;
        if (heroActions) heroActions.style.display = 'none';
        actionNote.textContent = status === 'RESOLVED' ? 'This alert is resolved — no further action.' : 'No active alert selected.';
        return;
    }

    if (heroActions) heroActions.style.display = '';

    if (status === 'ACTIVE') {
        acknowledgeBtn.disabled = false;
        resolveBtn.disabled = false;
        if (heroAckBtn) { heroAckBtn.disabled = false; heroAckBtn.className = 'btn btn-primary'; }
        if (heroResolveBtn) { heroResolveBtn.disabled = false; heroResolveBtn.className = 'btn btn-outline'; }
        actionNote.textContent = 'Alert is active — acknowledge or resolve.';
        document.getElementById('selectedStatusValue').textContent = 'Active';
    } else if (status === 'ACKNOWLEDGED') {
        acknowledgeBtn.disabled = true;
        resolveBtn.disabled = false;
        if (heroAckBtn) { heroAckBtn.disabled = true; heroAckBtn.className = 'btn btn-primary'; }
        if (heroResolveBtn) { heroResolveBtn.disabled = false; heroResolveBtn.className = 'btn btn-outline'; }
        actionNote.textContent = 'Alert acknowledged — ready to resolve.';
        document.getElementById('selectedStatusValue').textContent = 'Acknowledged';
    }
}

function updateStatusVisuals(status, trigger, event) {
    const hero = document.getElementById('heroCard');
    const heroIcon = document.getElementById('heroIcon');
    const heroTitle = document.getElementById('heroTitle');
    const heroDesc = document.getElementById('heroDesc');

    let heroClass, iconHtml, titleText, descText;

    if (status === 'NORMAL') {
        heroClass = 'hero normal';
        iconHtml = ICON_CHECK;
        titleText = 'All Clear';
        descText = 'No active emergencies. All signals reading normally.';
    } else if (status === 'RESOLVED') {
        heroClass = 'hero resolved';
        iconHtml = ICON_CHECK;
        titleText = 'Alert Resolved';
        descText = 'The selected emergency has been resolved and logged. No action required.';
    } else if (status === 'ACKNOWLEDGED') {
        heroClass = 'hero acknowledged';
        iconHtml = ICON_BELL;
        titleText = 'Acknowledged · Responding';
        descText = 'The emergency has been acknowledged. Response is in progress.';
    } else {
        switch (trigger) {
            case 'HEART_RATE':
                heroClass = 'hero warning';
                iconHtml = ICON_ALERT;
                titleText = 'Possible Emergency';
                descText = event && event.heartRate !== null && event.heartRate !== undefined
                    ? `Abnormal heart rate detected — ${event.heartRate} BPM. Monitor closely.`
                    : 'Abnormal heart rate detected. Monitor closely.';
                break;
            case 'SOS':
                heroClass = 'hero emergency';
                iconHtml = ICON_BELL;
                titleText = 'Needs Attention';
                descText = 'Manual SOS detected — caretaker attention requested.';
                break;
            case 'SOS_AND_HEART_RATE':
                heroClass = 'hero emergency';
                iconHtml = ICON_ALERT;
                titleText = 'Emergency · Action Needed';
                descText = 'SOS combined with abnormal heart rate. Immediate response recommended.';
                break;
            default:
                heroClass = 'hero emergency';
                iconHtml = ICON_ALERT;
                titleText = 'Emergency Alert';
                descText = 'An emergency event has been detected by the Smart Assistive Cap.';
        }
    }

    hero.className = heroClass;
    heroIcon.innerHTML = iconHtml;
    heroTitle.textContent = titleText;
    heroDesc.textContent = descText;
}

function updateHeroMetrics(event) {
    const activeEl = document.getElementById('heroActiveCount');
    const checkedEl = document.getElementById('heroLastChecked');
    const idEl = document.getElementById('heroAlertId');

    let count = 0;
    alertsById.forEach(alert => {
        if (alert.status === 'ACTIVE') count++;
    });

    if (event.status === 'NORMAL') {
        activeEl.textContent = 'No active alert';
        activeEl.className = 'hero-chip chip-neutral';
    } else if (count === 0) {
        activeEl.textContent = 'No active alert';
        activeEl.className = 'hero-chip chip-neutral';
    } else {
        activeEl.textContent = `${count} active alert${count > 1 ? 's' : ''}`;
        activeEl.className = 'hero-chip chip-alert';
    }

    checkedEl.textContent = `Checked ${formatTime(event.timestamp)}`;

    if (event.alertId) {
        idEl.textContent = event.alertId;
        idEl.style.display = '';
    } else {
        idEl.style.display = 'none';
    }
}

function updateAlertDetails(event) {
    const panelEmpty = document.getElementById('selectedPanelEmpty');
    const panelContent = document.getElementById('selectedContent');

    const hasAlert = event && event.status !== 'NORMAL' && event.alertId;

    if (!hasAlert) {
        panelContent.style.display = 'none';
        panelEmpty.style.display = '';
        return;
    }

    panelContent.style.display = '';
    panelEmpty.style.display = 'none';

    const triggerClass = getTriggerClass(event.trigger);
    document.getElementById('selectedTrigger').textContent = getTriggerLabel(event.trigger);
    document.getElementById('selectedId').textContent = event.alertId;

    const statusEl = document.getElementById('selectedStatus');
    statusEl.className = `selected-status ${getDetailStatusClass(event.status)}`;
    statusEl.innerHTML = `<span class="dot"></span>${getStatusLabel(event.status)}`;

    const statusValueEl = document.getElementById('selectedStatusValue');
    statusValueEl.textContent = getStatusLabel(event.status);
    statusValueEl.className = `detail-value ${getDetailStatusClass(event.status)}`;

    const tierEl = document.getElementById('selectedTier');
    const sevClass = event.trigger === 'HEART_RATE' ? 't-warning' : (triggerClass === 'sos' ? 't-emergency' : 't-neutral');
    tierEl.className = `selected-tier ${sevClass}`;
    tierEl.textContent = event.trigger === 'HEART_RATE' ? 'Possible Emergency' : (triggerClass === 'sos' ? 'Emergency' : 'Normal');

    const hrEl = document.getElementById('selectedHeartRate');
    if (event.heartRate !== null && event.heartRate !== undefined) {
        hrEl.textContent = `${event.heartRate} BPM`;
        hrEl.className = 'detail-value';
    } else {
        hrEl.textContent = 'No reading available';
        hrEl.className = 'detail-value muted';
    }

    document.getElementById('selectedLogged').textContent = formatDateTime(event.timestamp);
    document.getElementById('selectedSource').textContent = getSourceLabel(event.source || 'API');
    document.getElementById('selectedLat').textContent = event.latitude.toFixed(4);
    document.getElementById('selectedLng').textContent = event.longitude.toFixed(4);
}

function updateHeartRateDisplay(event) {
    const hrValueEl = document.getElementById('heartRateValue');
    const hrStatusEl = document.getElementById('heartRateStatus');
    const hrUpdatedEl = document.getElementById('heartRateUpdated');
    const pulseEl = document.getElementById('pulseWave');
    const rangeNeedleEl = document.getElementById('hrRangeNeedle');

    let hrStatusText, hrColor;

    if (event.trigger === 'NORMAL' || event.status === 'NORMAL') {
        if (event.heartRate !== null && event.heartRate !== undefined) {
            hrValueEl.innerHTML = `${event.heartRate}<span class="vital-unit">BPM</span>`;
            hrStatusText = 'Normal';
            hrColor = 'var(--ok)';
        } else {
            hrValueEl.innerHTML = `—<span class="vital-unit">BPM</span>`;
            hrStatusText = 'No data';
            hrColor = 'var(--text-3)';
        }
    } else if (event.heartRate !== null && event.heartRate !== undefined) {
        hrValueEl.innerHTML = `${event.heartRate}<span class="vital-unit">BPM</span>`;
        hrStatusText = event.trigger === 'SOS_AND_HEART_RATE' ? 'Critical' : 'Abnormal';
        hrColor = event.trigger === 'SOS_AND_HEART_RATE' ? 'var(--emergency)' : 'var(--warn)';
    } else {
        hrValueEl.innerHTML = `—<span class="vital-unit">BPM</span>`;
        hrStatusText = 'No data';
        hrColor = 'var(--text-3)';
    }

    hrValueEl.style.color = hrColor;
    hrStatusEl.className = 'hr-status-badge ' + (event.heartRate === null || event.heartRate === undefined
        ? 'b-muted'
        : event.trigger === 'SOS_AND_HEART_RATE' ? 'b-critical' : (event.trigger === 'NORMAL' || event.status === 'NORMAL' ? 'b-normal' : 'b-warning'));
    hrStatusEl.innerHTML = `<span class="badge-dot"></span>${hrStatusText}`;

    if (event.heartRate !== null && event.heartRate !== undefined) {
        hrUpdatedEl.textContent = `Last valid reading · ${formatTime(event.timestamp)}`;
        hrValueEl.style.opacity = '1';
        pulseEl.classList.remove('stop');
    } else {
        hrUpdatedEl.textContent = event.status === 'NORMAL' ? `Checked ${formatTime(event.timestamp)}` : 'No reading available';
        hrValueEl.style.opacity = '1';
        pulseEl.classList.add('stop');
    }

    rangeNeedleEl.style.backgroundColor = hrColor;
    if (event.heartRate !== null && event.heartRate !== undefined) {
        const pct = Math.max(0, Math.min(100, ((event.heartRate - 40) / 160) * 100));
        rangeNeedleEl.style.left = `${pct}%`;
        rangeNeedleEl.style.opacity = '1';
    } else {
        rangeNeedleEl.style.opacity = '0';
        rangeNeedleEl.style.left = '26%';
    }
}

function handleEvent(event) {
    currentAlert = { ...event };

    updateStatusVisuals(event.status, event.trigger, event);
    updateHeroMetrics(event);
    updateHeartRateDisplay(event);

    const locationTimestampEl = document.getElementById('locationTimestamp');
    if (locationTimestampEl) locationTimestampEl.textContent = formatTime(event.timestamp);

    const latitudeEl = document.getElementById('latitude');
    const longitudeEl = document.getElementById('longitude');
    if (latitudeEl) latitudeEl.textContent = event.latitude.toFixed(4);
    if (longitudeEl) longitudeEl.textContent = event.longitude.toFixed(4);

    const srcEl = document.getElementById('locationSource');
    if (srcEl) srcEl.textContent = getSourceLabel(event.source || 'API');
    const srcFooterEl = document.getElementById('locationSourceFooter');
    if (srcFooterEl) srcFooterEl.textContent = getSourceLabel(event.source || 'API');

    updateMapLocation(event.latitude, event.longitude, event.alertId || null);
    updateAlertDetails(event);
    updateActionButtons(event.status);
}

function setHeartRateEnabled(enabled) {
    heartRateEnabled = enabled;
    updateHeartRateFeatureUI();
}

function updateHeartRateFeatureUI() {
    const hrCard = document.getElementById('overview');
    const mainGrid = document.querySelector('.main-grid');
    const deviceHrRow = document.getElementById('deviceHrRow');
    const deviceHrValue = document.getElementById('deviceHrValue');
    const simHeartRateBtn = document.getElementById('simHeartRate');
    const simSOSHeartRateBtn = document.getElementById('simSOSHeartRate');
    const toggle = document.getElementById('heartRateToggle');
    const toggleStatus = document.getElementById('heartRateToggleStatus');
    const toggleDesc = document.getElementById('heartRateToggleDesc');

    const hrSimButtons = [simHeartRateBtn, simSOSHeartRateBtn].filter(Boolean);
    const hrGroups = [hrCard, deviceHrRow].filter(Boolean);

    if (heartRateEnabled) {
        hrGroups.forEach(el => { el.style.display = ''; });
        hrSimButtons.forEach(el => { el.style.display = ''; });
        if (mainGrid) mainGrid.classList.remove('hr-off');
        if (deviceHrValue) deviceHrValue.innerHTML = '<span class="row-dot ok"></span>Simulated';
    } else {
        hrGroups.forEach(el => { el.style.display = 'none'; });
        hrSimButtons.forEach(el => { el.style.display = 'none'; });
        if (mainGrid) mainGrid.classList.add('hr-off');
        if (deviceHrValue) deviceHrValue.innerHTML = '<span class="row-dot acid"></span>Not installed';
    }

    if (toggle) toggle.checked = heartRateEnabled;
    if (toggleStatus) {
        toggleStatus.textContent = heartRateEnabled ? 'Enabled' : 'Disabled';
        toggleStatus.className = 'sensor-toggle-title ' + (heartRateEnabled ? 'enabled' : 'disabled');
    }
    if (toggleDesc) {
        toggleDesc.textContent = heartRateEnabled ? 'Sensor-based HR monitoring' : 'Heart-rate hardware not included';
    }
    if (toggle) {
        toggle.setAttribute('aria-label', heartRateEnabled ? 'Heart Rate Sensor Enabled' : 'Heart Rate Sensor Disabled');
    }

    if (map) {
        requestAnimationFrame(() => map.invalidateSize());
    }
}

async function updateAlertStatus(alertId, status) {
    if (!isApiPollingRunning) return;
    try {
        const response = await fetch(`${EVENTS_ENDPOINT}/${encodeURIComponent(alertId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ status })
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.warn(`[API] Failed to update ${alertId} to ${status}:`, error.message || error);
    }
}

function acknowledgeAlert() {
    const alert = selectedAlertId ? alertsById.get(selectedAlertId) : null;
    if (!alert || alert.status !== 'ACTIVE') return;

    alert.status = 'ACKNOWLEDGED';
    handleEvent(alert);
    updateHistoryRow(alert.alertId, 'ACKNOWLEDGED');
    updateAlertStatus(alert.alertId, 'ACKNOWLEDGED');
}

function resolveAlert() {
    const alert = selectedAlertId ? alertsById.get(selectedAlertId) : null;
    if (!alert || alert.status === 'RESOLVED' || alert.status === 'NORMAL') return;

    alert.status = 'RESOLVED';
    handleEvent(alert);
    updateHistoryRow(alert.alertId, 'RESOLVED');
    updateAlertStatus(alert.alertId, 'RESOLVED');
}

function generateRandomLocation() {
    const latVariation = (Math.random() - 0.5) * 0.004;
    const lngVariation = (Math.random() - 0.5) * 0.004;
    baseLatitude += latVariation;
    baseLongitude += lngVariation;
    baseLatitude = Math.max(22.3052, Math.min(22.3092, baseLatitude));
    baseLongitude = Math.max(73.1792, Math.min(73.1832, baseLongitude));
    return { latitude: baseLatitude, longitude: baseLongitude };
}

function generateRandomHeartRate(trigger) {
    if (trigger === 'SOS') return null;
    if (trigger === 'HEART_RATE') return Math.floor(Math.random() * 30) + 130;
    if (trigger === 'SOS_AND_HEART_RATE') return Math.floor(Math.random() * 30) + 130;
    return Math.floor(Math.random() * 20) + 70;
}

function getRandomTrigger() {
    const triggers = heartRateEnabled
        ? ['SOS', 'HEART_RATE', 'SOS_AND_HEART_RATE']
        : ['SOS'];
    const weights = heartRateEnabled ? [0.4, 0.35, 0.25] : [1];
    const rand = Math.random();
    let sum = 0;
    for (let i = 0; i < triggers.length; i++) {
        sum += weights[i];
        if (rand < sum) return triggers[i];
    }
    return triggers[0];
}

function createSimulatedEvent() {
    const trigger = getRandomTrigger();
    const location = generateRandomLocation();
    const heartRate = generateRandomHeartRate(trigger);

    return {
        alertId: generateAlertId(),
        trigger: trigger,
        status: 'ACTIVE',
        heartRate: heartRate,
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: new Date().toISOString(),
        source: 'AUTO SIM'
    };
}

function processEmergencyEvent(event) {
    const stored = { ...event };
    if (!stored.source) stored.source = 'API';
    alertsById.set(stored.alertId, stored);
    addToHistory(stored);
    selectAlert(stored.alertId);
}

function processNormalEvent(event) {
    currentAlert = null;
    selectedAlertId = null;
    highlightSelectedHistoryRow(null);
    handleEvent(event);
}

function highlightSelectedHistoryRow(alertId) {
    document.querySelectorAll('#alertHistoryList .history-item').forEach(row => {
        row.classList.toggle('selected', row.dataset.alertId === alertId);
    });
}

function selectAlert(alertId) {
    if (!alertId || !alertsById.has(alertId)) {
        selectedAlertId = null;
        currentAlert = null;
        highlightSelectedHistoryRow(null);
        return;
    }

    const alert = alertsById.get(alertId);
    selectedAlertId = alertId;
    currentAlert = { ...alert };
    handleEvent(alert);
    highlightSelectedHistoryRow(alertId);
}

function validateEvent(event) {
    if (!event || typeof event !== 'object') {
        console.warn('[Events] Ignored invalid event: not an object.');
        return false;
    }

    if (event.status === 'NORMAL') {
        return true;
    }

    const validTriggers = ['SOS', 'HEART_RATE', 'SOS_AND_HEART_RATE'];
    if (!validTriggers.includes(event.trigger)) {
        console.warn(`[Events] Ignored invalid event: unknown trigger "${event.trigger}".`);
        return false;
    }

    const required = ['alertId', 'status', 'latitude', 'longitude', 'timestamp'];
    for (const field of required) {
        const value = event[field];
        if (value === undefined || value === null || value === '') {
            console.warn(`[Events] Ignored invalid event: missing "${field}".`);
            return false;
        }
    }

    if (typeof event.latitude !== 'number' || typeof event.longitude !== 'number') {
        console.warn('[Events] Ignored invalid event: latitude/longitude must be numbers.');
        return false;
    }

    if (event.trigger === 'HEART_RATE' || event.trigger === 'SOS_AND_HEART_RATE') {
        if (typeof event.heartRate !== 'number' || !isFinite(event.heartRate) || event.heartRate <= 0) {
            console.warn(`[Events] Ignored invalid event: heartRate must be a positive number for "${event.trigger}".`);
            return false;
        }
    } else if (event.heartRate !== null && event.heartRate !== undefined &&
               (typeof event.heartRate !== 'number' || !isFinite(event.heartRate))) {
        console.warn('[Events] Ignored invalid event: heartRate must be null or a number for "SOS".');
        return false;
    }

    if (isNaN(Date.parse(event.timestamp))) {
        console.warn('[Events] Ignored invalid event: invalid timestamp.');
        return false;
    }

    return true;
}

function receiveEvent(event) {
    if (!validateEvent(event)) {
        return;
    }

    if (!heartRateEnabled) {
        if (event.trigger === 'HEART_RATE') {
            console.warn('[HR] Heart-rate sensor disabled — HEART_RATE event ignored.');
            return;
        }
        if (event.trigger === 'SOS_AND_HEART_RATE') {
            event = { ...event, trigger: 'SOS', heartRate: null };
        }
    }

    if (event.status === 'NORMAL') {
        if (!heartRateEnabled) {
            event = { ...event, heartRate: null };
        }
        processNormalEvent(event);
        return;
    }

    if (processedAlertIds.has(event.alertId)) {
        console.warn(`[Events] Duplicate alertId "${event.alertId}" ignored.`);
        return;
    }

    processedAlertIds.add(event.alertId);
    processEmergencyEvent(event);
}

function trimHistory() {
    const list = document.getElementById('alertHistoryList');
    if (!list) return;
    const items = list.querySelectorAll('.history-item');
    if (items.length > MAX_HISTORY_ENTRIES) {
        for (let i = MAX_HISTORY_ENTRIES; i < items.length; i++) {
            items[i].remove();
        }
    }
}

function updateSimulationStatus() {
    const statusEl = document.getElementById('simulationStatus');
    const toggleBtn = document.getElementById('simulationToggleBtn');
    const simChip = document.getElementById('demoSimChip');

    if (statusEl) {
        const dot = statusEl.querySelector('.status-dot');
        const label = statusEl.querySelector('span:not(.status-dot)');
        dot.style.backgroundColor = isSimulationRunning ? 'var(--warn)' : 'var(--text-3)';
        label.textContent = isSimulationRunning ? 'Active' : 'Off';
    }

    if (toggleBtn) {
        toggleBtn.textContent = isSimulationRunning ? 'Stop Simulation' : 'Start Simulation';
        toggleBtn.className = isSimulationRunning ? 'btn btn-outline' : 'btn btn-primary';
    }

    if (simChip) {
        const dot = simChip.querySelector('.dot');
        dot.style.backgroundColor = isSimulationRunning ? 'var(--warn)' : 'var(--text-3)';
        simChip.lastChild.textContent = isSimulationRunning ? ' Simulation: Active' : ' Simulation: Off';
    }
}

function simulationLoop() {
    if (!isSimulationRunning) return;

    const event = createSimulatedEvent();
    receiveEvent(event);

    const interval = 5000 + Math.random() * 5000;
    simulationTimer = setTimeout(simulationLoop, interval);
}

function startSimulation() {
    if (isSimulationRunning) return;

    isSimulationRunning = true;
    updateSimulationStatus();
    simulationLoop();
}

function stopSimulation() {
    if (!isSimulationRunning) return;

    isSimulationRunning = false;
    if (simulationTimer) {
        clearTimeout(simulationTimer);
        simulationTimer = null;
    }
    updateSimulationStatus();
}

function toggleSimulation() {
    if (isSimulationRunning) {
        stopSimulation();
    } else {
        startSimulation();
    }
}

function collectProcessedAlertIds() {
    document.querySelectorAll('#alertHistoryList .history-alert-id').forEach(cell => {
        const text = cell.textContent.trim();
        if (text) processedAlertIds.add(text);
    });
}

function setConnectionIndicator(state) {
    const dot = document.getElementById('connectionDot');
    const text = document.getElementById('connectionText');
    const banner = document.getElementById('systemStateBanner');
    const bannerTitle = document.getElementById('systemStateTitle');
    const bannerDesc = document.getElementById('systemStateDesc');

    if (state === 'connected') {
        if (dot) dot.style.backgroundColor = 'var(--ok)';
        if (text) text.textContent = 'API Connected';
        if (banner) banner.className = 'status-ribbon sys-connected';
        if (bannerTitle) bannerTitle.textContent = 'API Connected';
        if (bannerDesc) bannerDesc.textContent = 'Receiving events from backend.';
    } else if (state === 'offline') {
        if (dot) dot.style.backgroundColor = 'var(--text-3)';
        if (text) text.textContent = 'API Offline';
        if (banner) banner.className = 'status-ribbon sys-offline';
        if (bannerTitle) bannerTitle.textContent = 'API Offline';
        if (bannerDesc) bannerDesc.textContent = 'Dashboard is running in demo mode — unable to reach backend.';
    } else if (state === 'pending') {
        if (dot) dot.style.backgroundColor = 'var(--warn)';
        if (text) text.textContent = 'Connecting…';
        if (banner) banner.className = 'status-ribbon sys-pending';
        if (bannerTitle) bannerTitle.textContent = 'Connecting to API';
        if (bannerDesc) bannerDesc.textContent = 'Attempting to reach backend.';
    } else {
        if (dot) dot.style.backgroundColor = 'var(--brand)';
        if (text) text.textContent = 'Demo Mode';
        if (banner) banner.className = 'status-ribbon sys-demo';
        if (bannerTitle) bannerTitle.textContent = 'Demo Mode';
        if (bannerDesc) bannerDesc.textContent = 'Frontend simulation active. No backend connection.';
    }
}

function setApiStatus(state) {
    apiStatus = state;
    const statusEl = document.getElementById('apiStatus');
    const toggleBtn = document.getElementById('apiPollingBtn');
    const apiChip = document.getElementById('demoApiChip');

    if (statusEl) {
        const dot = statusEl.querySelector('.status-dot');
        const label = statusEl.querySelector('span:not(.status-dot)');

        if (!isApiPollingRunning) {
            dot.style.backgroundColor = 'var(--text-3)';
            label.textContent = 'Disconnected';
        } else {
            const statusLabel = state === 'connected' ? 'Connected' : state === 'offline' ? 'Offline' : 'Polling…';
            dot.style.backgroundColor = state === 'connected' ? 'var(--ok)' : state === 'offline' ? 'var(--emergency)' : 'var(--warn)';
            label.textContent = statusLabel;
        }
    }

    if (toggleBtn) {
        toggleBtn.textContent = isApiPollingRunning ? 'Disconnect API' : 'Connect API';
        toggleBtn.className = isApiPollingRunning ? 'btn btn-outline' : 'btn btn-primary';
    }

    if (apiChip) {
        const dot = apiChip.querySelector('.dot');
        const label = !isApiPollingRunning ? 'Disconnected' : state === 'connected' ? 'Connected' : state === 'offline' ? 'Offline' : 'Polling…';
        dot.style.backgroundColor = !isApiPollingRunning ? 'var(--text-3)' : state === 'connected' ? 'var(--ok)' : state === 'offline' ? 'var(--emergency)' : 'var(--warn)';
        apiChip.lastChild.textContent = ` API: ${label}`;
    }

    const deviceApiDot = document.getElementById('deviceApiDot');
    const deviceApiLabel = document.getElementById('deviceApiLabel');
    if (deviceApiDot && deviceApiLabel) {
        if (!isApiPollingRunning) {
            deviceApiDot.className = 'row-dot acid';
            deviceApiLabel.textContent = 'Not connected';
        } else if (state === 'connected') {
            deviceApiDot.className = 'row-dot ok';
            deviceApiLabel.textContent = 'API Connected';
        } else if (state === 'offline') {
            deviceApiDot.className = 'row-dot warn';
            deviceApiLabel.textContent = 'API Offline';
        } else {
            deviceApiDot.className = 'row-dot warn';
            deviceApiLabel.textContent = 'Connecting…';
        }
    }

    setConnectionIndicator(isApiPollingRunning
        ? (state === 'connected' ? 'connected' : state === 'pending' ? 'pending' : 'offline')
        : 'demo');
}

async function fetchEventsFromAPI() {
    const response = await fetch(EVENTS_ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const events = Array.isArray(data) ? data : (data && Array.isArray(data.events) ? data.events : null);
    if (!events) {
        throw new Error('Unexpected response shape');
    }
    return events;
}

async function receiveEventFromAPI(event) {
    if (Array.isArray(event)) {
        for (const item of event) {
            await receiveEventFromAPI(item);
        }
        return;
    }
    receiveEvent(event);
}

async function apiPollLoop(epoch) {
    if (!isApiPollingRunning || epoch !== apiPollingEpoch) return;

    try {
        const events = await fetchEventsFromAPI();
        setApiStatus('connected');
        await receiveEventFromAPI(events);
    } catch (error) {
        if (apiStatus !== 'offline') {
            console.warn('[API] Polling failed:', error.message || error);
        }
        setApiStatus('offline');
    }

    if (isApiPollingRunning && epoch === apiPollingEpoch) {
        apiPollingTimer = setTimeout(() => apiPollLoop(apiPollingEpoch), API_POLL_INTERVAL);
    }
}

function startApiPolling() {
    if (isApiPollingRunning) return;

    isApiPollingRunning = true;
    apiPollingEpoch += 1;
    setApiStatus('pending');
    apiPollLoop(apiPollingEpoch);
}

function stopApiPolling() {
    if (!isApiPollingRunning) return;

    isApiPollingRunning = false;
    if (apiPollingTimer) {
        clearTimeout(apiPollingTimer);
        apiPollingTimer = null;
    }
    setApiStatus('unknown');
}

function toggleApiPolling() {
    if (isApiPollingRunning) {
        stopApiPolling();
    } else {
        startApiPolling();
    }
}

async function fetchLocationFromAPI() {
    const response = await fetch(LOCATION_ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (typeof data !== 'object' || data === null ||
        typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
        throw new Error('Unexpected location response shape');
    }
    return data;
}

async function postLocationToAPI(latitude, longitude, timestamp) {
    try {
        const response = await fetch(LOCATION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ latitude, longitude, timestamp: timestamp || new Date().toISOString() })
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.warn('[Location] Failed to publish browser GPS:', error.message || error);
    }
}

function publishBrowserLocation() {
    if (!isLocationPollingRunning) return;
    if (!navigator.geolocation) {
        console.warn('[Location] navigator.geolocation is not available in this browser.');
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (position) => {
            postLocationToAPI(
                position.coords.latitude,
                position.coords.longitude,
                new Date(position.timestamp).toISOString()
            );
        },
        (err) => {
            console.warn('[Location] Browser geolocation error:', err && err.message);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
}

function startLocationPolling() {
    if (isLocationPollingRunning) return;

    isLocationPollingRunning = true;
    locationPollingEpoch += 1;
    publishBrowserLocation();
    locationPollLoop(locationPollingEpoch);
}

function setLocationStatus(state) {
    const statusEl = document.getElementById('locationApiStatus');
    const toggleBtn = document.getElementById('locationPollingBtn');
    if (!statusEl) return;

    const dot = statusEl.querySelector('.status-dot');
    const label = statusEl.querySelector('span:not(.status-dot)');

    if (!isLocationPollingRunning) {
        dot.style.backgroundColor = 'var(--text-3)';
        label.textContent = 'Disconnected';
    } else {
        const statusLabel = state === 'connected' ? 'Connected' : state === 'offline' ? 'Offline' : 'Polling…';
        dot.style.backgroundColor = state === 'connected' ? 'var(--ok)' : state === 'offline' ? 'var(--emergency)' : 'var(--warn)';
        label.textContent = statusLabel;
    }

    if (toggleBtn) {
        toggleBtn.textContent = isLocationPollingRunning ? 'Disconnect Location' : 'Connect Location';
        toggleBtn.className = isLocationPollingRunning ? 'btn btn-outline' : 'btn btn-primary';
    }
}

async function locationPollLoop(epoch) {
    if (!isLocationPollingRunning || epoch !== locationPollingEpoch) return;

    try {
        const location = await fetchLocationFromAPI();
        handleLocationUpdate(location.latitude, location.longitude, location.timestamp || null);
        setLocationStatus('connected');
    } catch (error) {
        console.warn('[Location] Polling failed:', error.message || error);
        setLocationStatus('offline');
    }

    if (isLocationPollingRunning && epoch === locationPollingEpoch) {
        locationPollingTimer = setTimeout(() => locationPollLoop(locationPollingEpoch), LOCATION_POLL_INTERVAL);
    }
}

function stopLocationPolling() {
    if (!isLocationPollingRunning) return;

    isLocationPollingRunning = false;
    if (locationPollingTimer) {
        clearTimeout(locationPollingTimer);
        locationPollingTimer = null;
    }
    setLocationStatus('unknown');
}

function toggleLocationPolling() {
    if (isLocationPollingRunning) {
        stopLocationPolling();
    } else {
        startLocationPolling();
    }
}

function parseHistoryTimestamp(timeText) {
    const now = new Date();
    const match = timeText && timeText.match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])/);
    if (!match) return now.toISOString();
    let hours = parseInt(match[1], 10) % 12;
    if (match[3].toLowerCase() === 'pm') hours += 12;
    now.setHours(hours, parseInt(match[2], 10), 0, 0);
    return now.toISOString();
}

function parseHistoryRow(row) {
    const alertId = row.querySelector('.history-alert-id')?.textContent?.trim();
    if (!alertId) return null;

    const triggerLabel = row.querySelector('.history-trigger')?.textContent?.trim();
    let trigger;
    if (triggerLabel === 'Manual SOS') trigger = 'SOS';
    else if (triggerLabel === 'Abnormal Heart Rate') trigger = 'HEART_RATE';
    else if (triggerLabel === 'SOS + Abnormal Heart Rate') trigger = 'SOS_AND_HEART_RATE';
    else return null;

    const heartRateText = row.querySelector('.history-heart-rate')?.textContent?.trim();
    let heartRate = null;
    if (heartRateText && heartRateText !== '—') {
        const match = heartRateText.match(/(\d+)/);
        if (match) heartRate = parseInt(match[1], 10);
    }

    const locationText = row.querySelector('.history-location')?.textContent?.trim();
    let latitude = 22.3072, longitude = 73.1812;
    if (locationText) {
        const coords = locationText.split(',').map(s => parseFloat(s.trim()));
        if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
            latitude = coords[0];
            longitude = coords[1];
        }
    }

    const statusLabel = row.querySelector('.history-status')?.textContent?.trim();
    let status = 'ACTIVE';
    if (statusLabel === 'Resolved') status = 'RESOLVED';
    else if (statusLabel === 'Acknowledged') status = 'ACKNOWLEDGED';

    const sourceText = row.querySelector('.history-source')?.textContent?.trim();
    const source = sourceText === 'Demo' ? 'DEMO' : sourceText === 'Auto Simulation' ? 'AUTO SIM' : 'API';

    const timeText = row.querySelector('.history-time')?.textContent?.trim();

    return {
        alertId,
        trigger,
        status,
        heartRate,
        latitude,
        longitude,
        timestamp: parseHistoryTimestamp(timeText),
        source
    };
}

function initializeFromHistory() {
    const rows = document.querySelectorAll('#alertHistoryList .history-item');
    let newestEvent = null;

    rows.forEach(row => {
        const event = parseHistoryRow(row);
        if (event && event.status !== 'NORMAL') {
            row.dataset.alertId = event.alertId;
            alertsById.set(event.alertId, event);
            if (!newestEvent) newestEvent = event;
        }
    });

    updateHistoryEmptyState();

    if (newestEvent) {
        selectAlert(newestEvent.alertId);
    }
}

function renderInitialHistory() {
    const list = document.getElementById('alertHistoryList');
    if (!list) return;

    const now = Date.now();
    const seed = [
        { id: 'ALT-001', trigger: 'SOS', status: 'ACTIVE', heartRate: null, minutesAgo: 4, source: 'DEMO' },
        { id: 'ALT-002', trigger: 'HEART_RATE', status: 'RESOLVED', heartRate: 138, minutesAgo: 26, source: 'DEMO' },
        { id: 'ALT-003', trigger: 'SOS_AND_HEART_RATE', status: 'RESOLVED', heartRate: 141, minutesAgo: 71, source: 'DEMO' },
        { id: 'ALT-004', trigger: 'HEART_RATE', status: 'RESOLVED', heartRate: 129, minutesAgo: 129, source: 'DEMO' },
        { id: 'ALT-005', trigger: 'SOS', status: 'RESOLVED', heartRate: null, minutesAgo: 188, source: 'DEMO' }
    ];

    for (let i = seed.length - 1; i >= 0; i--) {
        const item = seed[i];
        const location = generateRandomLocation();
        const event = {
            alertId: item.id,
            trigger: item.trigger,
            status: item.status,
            heartRate: item.heartRate,
            latitude: location.latitude,
            longitude: location.longitude,
            timestamp: new Date(now - item.minutesAgo * 60000).toISOString(),
            source: item.source
        };
        list.insertBefore(createHistoryRow(event), list.firstChild);
    }
}

function tickClock() {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const now = new Date();
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    el.textContent = `${date} · ${time}`;
}

document.getElementById('acknowledgeBtn').addEventListener('click', acknowledgeAlert);
document.getElementById('resolveBtn').addEventListener('click', resolveAlert);
document.getElementById('heroAckBtn').addEventListener('click', acknowledgeAlert);
document.getElementById('heroResolveBtn').addEventListener('click', resolveAlert);
document.getElementById('simulationToggleBtn').addEventListener('click', toggleSimulation);
document.getElementById('apiPollingBtn').addEventListener('click', toggleApiPolling);

const locationPollingBtnEl = document.getElementById('locationPollingBtn');
if (locationPollingBtnEl) {
    locationPollingBtnEl.addEventListener('click', toggleLocationPolling);
}

document.getElementById('alertHistoryList').addEventListener('click', (event) => {
    const row = event.target.closest('.history-item');
    if (!row) return;
    const alertId = row.dataset.alertId;
    if (alertId && alertsById.has(alertId)) {
        selectAlert(alertId);
    }
});

document.getElementById('demoPanelToggle').addEventListener('click', () => {
    const panel = document.getElementById('demo');
    const toggle = document.getElementById('demoPanelToggle');
    const open = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

const heartRateToggleEl = document.getElementById('heartRateToggle');
if (heartRateToggleEl) {
    heartRateToggleEl.addEventListener('change', (e) => {
        setHeartRateEnabled(e.target.checked);
    });
}

const navToggle = document.getElementById('navToggle');
const sidebarEl = document.querySelector('.sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
if (navToggle && sidebarEl) {
    const setNavOpen = (open) => {
        sidebarEl.classList.toggle('open', open);
        navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (sidebarBackdrop) {
            sidebarBackdrop.classList.toggle('show', open);
            sidebarBackdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
    };
    navToggle.addEventListener('click', () => {
        setNavOpen(!sidebarEl.classList.contains('open'));
    });
    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', () => setNavOpen(false));
    }
    sidebarEl.querySelectorAll('.nav-item').forEach(link => {
        link.addEventListener('click', () => setNavOpen(false));
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth > 1180) setNavOpen(false);
    });
}

document.getElementById('simNormal').addEventListener('click', () => {
    currentAlert = null;
    const location = generateRandomLocation();
    const event = {
        alertId: null,
        trigger: 'NORMAL',
        status: 'NORMAL',
        heartRate: heartRateEnabled ? generateRandomHeartRate('NORMAL') : null,
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: new Date().toISOString(),
        source: 'DEMO'
    };
    receiveEvent(event);
});

document.getElementById('simSOS').addEventListener('click', () => {
    const event = {
        alertId: generateAlertId(),
        trigger: 'SOS',
        status: 'ACTIVE',
        heartRate: null,
        latitude: 22.3072,
        longitude: 73.1812,
        timestamp: new Date().toISOString(),
        source: 'DEMO'
    };
    receiveEvent(event);
});

document.getElementById('simHeartRate').addEventListener('click', () => {
    const event = {
        alertId: generateAlertId(),
        trigger: 'HEART_RATE',
        status: 'ACTIVE',
        heartRate: 142,
        latitude: 22.3072,
        longitude: 73.1812,
        timestamp: new Date().toISOString(),
        source: 'DEMO'
    };
    receiveEvent(event);
});

document.getElementById('simSOSHeartRate').addEventListener('click', () => {
    const event = {
        alertId: generateAlertId(),
        trigger: 'SOS_AND_HEART_RATE',
        status: 'ACTIVE',
        heartRate: 142,
        latitude: 22.3072,
        longitude: 73.1812,
        timestamp: new Date().toISOString(),
        source: 'DEMO'
    };
    receiveEvent(event);
});

renderInitialHistory();
collectProcessedAlertIds();
updateHeartRateFeatureUI();

const apiEndpointEl = document.getElementById('apiEndpoint');
if (apiEndpointEl) apiEndpointEl.textContent = EVENTS_ENDPOINT;
const ribbonEndEl = document.getElementById('systemStateEndpoint');
if (ribbonEndEl) ribbonEndEl.textContent = EVENTS_ENDPOINT;

setApiStatus('unknown');
setLocationStatus('unknown');
initMap(baseLatitude, baseLongitude);
initializeFromHistory();
tickClock();
setInterval(tickClock, 1000);
