'use strict';

const LOCATION_FRESHNESS_MS = 5 * 60 * 1000;
const DEVICE_STATUS_FRESHNESS_MS = 2 * 60 * 1000;
const HEART_RATE_FRESHNESS_MS = 2 * 60 * 1000;
const OBSTACLE_FRESHNESS_MS = 30 * 1000;

const OBSTACLE_TRIGGERS = new Set(['OBSTACLE_LEFT', 'OBSTACLE_CENTER', 'OBSTACLE_RIGHT']);

const DIRECTION_LABEL = {
    OBSTACLE_LEFT: 'LEFT',
    OBSTACLE_CENTER: 'CENTER',
    OBSTACLE_RIGHT: 'RIGHT'
};

const EMERGENCY_TRIGGERS = new Set(['SOS', 'SOS_AND_HEART_RATE']);

function ageSeconds(isoTimestamp) {
    const parsed = Date.parse(isoTimestamp);
    if (Number.isNaN(parsed)) return null;
    return Math.round((Date.now() - parsed) / 1000);
}

function formatAge(seconds) {
    if (seconds === null || seconds === undefined) return null;
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    return Math.round(seconds / 3600) + 'h ago';
}

function buildTrustedContext(state) {
    const lines = [];

    if (state.latestLocation &&
        typeof state.latestLocation.latitude === 'number' &&
        typeof state.latestLocation.longitude === 'number' &&
        state.latestLocation.timestamp) {
        const age = ageSeconds(state.latestLocation.timestamp);
        if (age !== null && age <= LOCATION_FRESHNESS_MS / 1000) {
            const lat = state.latestLocation.latitude;
            const lng = state.latestLocation.longitude;
            const ageStr = formatAge(age);
            lines.push('Location: ' + lat + ', ' + lng + (ageStr ? ' (' + ageStr + ')' : ''));
        }
    }

    if (state.latestDeviceStatus &&
        typeof state.latestDeviceStatus.status === 'string' &&
        state.latestDeviceStatus.status.trim() !== '') {
        const age = ageSeconds(state.latestDeviceStatus.receivedAt);
        if (age !== null && age <= DEVICE_STATUS_FRESHNESS_MS / 1000) {
            let deviceLine = 'Device: ' + state.latestDeviceStatus.status;
            if (state.latestDeviceStatus.wifi) {
                deviceLine += ', WiFi ' + state.latestDeviceStatus.wifi;
            }
            const ageStr = formatAge(age);
            if (ageStr) deviceLine += ' (' + ageStr + ')';
            lines.push(deviceLine);
        }
    }

    if (state.lastHeartRate &&
        typeof state.lastHeartRate.heartRate === 'number' &&
        state.lastHeartRate.heartRate > 0) {
        const age = ageSeconds(state.lastHeartRate.timestamp);
        if (age !== null && age <= HEART_RATE_FRESHNESS_MS / 1000) {
            const ageStr = formatAge(age);
            lines.push('Heart rate: ' + state.lastHeartRate.heartRate + ' BPM' + (ageStr ? ' (' + ageStr + ')' : ''));
        }
    }

    if (state.latestBuzzerState === 'ON' || state.latestBuzzerState === 'OFF') {
        lines.push('Buzzer: ' + state.latestBuzzerState);
    }

    if (state.events && typeof state.events.forEach === 'function') {
        const obstacleMaxAgeSec = OBSTACLE_FRESHNESS_MS / 1000;

        const recentObstacles = [];
        state.events.forEach(function (event) {
            if (!OBSTACLE_TRIGGERS.has(event.trigger)) return;
            const age = ageSeconds(event.timestamp);
            if (age !== null && age <= obstacleMaxAgeSec && typeof event.distance === 'number') {
                recentObstacles.push({
                    direction: DIRECTION_LABEL[event.trigger] || event.trigger,
                    distance: event.distance,
                    age: age
                });
            }
        });

        recentObstacles.sort(function (a, b) { return a.age - b.age; });

        if (recentObstacles.length > 3) {
            recentObstacles.length = 3;
        }

        if (recentObstacles.length > 0) {
            const parts = recentObstacles.map(function (o) {
                return o.direction + ' ' + o.distance + 'm' + (formatAge(o.age) ? ' (' + formatAge(o.age) + ')' : '');
            });
            lines.push('Recent obstacles: ' + parts.join(', '));
        }
    }

    if (state.latestFall && state.latestFall.timestamp) {
        const age = ageSeconds(state.latestFall.timestamp);
        if (age !== null && age <= 10 * 60) {
            lines.push('Recent fall: ' + formatAge(age));
        }
    }

    if (lines.length === 0) {
        return '[Trusted Context]\nNo sensor data available.';
    }

    let sosActive = false;
    if (state.events && typeof state.events.forEach === 'function') {
        state.events.forEach(function (event) {
            if (EMERGENCY_TRIGGERS.has(event.trigger) && event.status === 'ACTIVE') {
                sosActive = true;
            }
        });
    }
    lines.push('SOS active: ' + (sosActive ? 'yes' : 'no'));

    return '[Trusted Context]\n' + lines.join('\n');
}

module.exports = { buildTrustedContext };
