const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.CORS_ORIGIN) {
    app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
} else {
    app.use(cors());
}
app.use(express.json());

const events = new Map();
let latestLocation = null;
const sseClients = new Set();

const VALID_TRIGGERS = ['SOS', 'HEART_RATE', 'SOS_AND_HEART_RATE', 'NORMAL', 'OBSTACLE_LEFT', 'OBSTACLE_CENTER', 'OBSTACLE_RIGHT'];
const VALID_STATUSES = ['NORMAL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'];

const ALLOWED_TRANSITIONS = {
    ACTIVE: ['ACKNOWLEDGED', 'RESOLVED'],
    ACKNOWLEDGED: ['RESOLVED'],
    RESOLVED: [],
    NORMAL: []
};

function isValidFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isValidLatitude(value) {
    return isValidFiniteNumber(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
    return isValidFiniteNumber(value) && value >= -180 && value <= 180;
}

function isValidTimestamp(value) {
    return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function broadcastEvent(event) {
    const data = `event: event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
        client.write(data);
    }
}

function validateLocation(location) {
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
        return 'Invalid location payload';
    }
    if (!isValidLatitude(location.latitude)) {
        return 'Invalid latitude';
    }
    if (!isValidLongitude(location.longitude)) {
        return 'Invalid longitude';
    }
    if (location.timestamp !== undefined && location.timestamp !== null && !isValidTimestamp(location.timestamp)) {
        return 'Invalid timestamp';
    }
    return null;
}

function validateEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return 'Invalid event payload';
    }

    if (typeof event.alertId !== 'string' || event.alertId.trim() === '') {
        return 'alertId must be a non-empty string';
    }

    if (!VALID_TRIGGERS.includes(event.trigger)) {
        return 'Invalid trigger';
    }

    if (!VALID_STATUSES.includes(event.status)) {
        return 'Invalid status';
    }

    if (event.heartRate !== null && event.heartRate !== undefined) {
        if (!isValidFiniteNumber(event.heartRate)) {
            return 'heartRate must be null or a finite number';
        }
    }

    if (event.latitude !== undefined && event.latitude !== null &&
        (!isValidFiniteNumber(event.latitude) || event.latitude < -90 || event.latitude > 90)) {
        return 'Invalid latitude';
    }

    if (event.longitude !== undefined && event.longitude !== null &&
        (!isValidFiniteNumber(event.longitude) || event.longitude < -180 || event.longitude > 180)) {
        return 'Invalid longitude';
    }

    if (!isValidTimestamp(event.timestamp)) {
        return 'Invalid timestamp';
    }

    return null;
}

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/api/events', (req, res) => {
    res.status(200).json(Array.from(events.values()));
});

app.get('/api/location', (req, res) => {
    if (latestLocation) {
        return res.status(200).json(latestLocation);
    }
    return res.status(200).json({ latitude: null, longitude: null, timestamp: null });
});

app.post('/api/location', (req, res) => {
    const location = req.body;

    const error = validateLocation(location);
    if (error) {
        return res.status(400).json({ error });
    }

    latestLocation = {
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: location.timestamp || new Date().toISOString()
    };

    return res.status(200).json(latestLocation);
});

app.post('/api/events', (req, res) => {
    const event = req.body;

    const error = validateEvent(event);
    if (error) {
        return res.status(400).json({ error });
    }

    if (events.has(event.alertId)) {
        return res.status(409).json({ error: 'Event with this alertId already exists' });
    }

    if (event.latitude === undefined || event.latitude === null ||
        event.longitude === undefined || event.longitude === null) {
        if (latestLocation && isValidLatitude(latestLocation.latitude) && isValidLongitude(latestLocation.longitude)) {
            event.latitude = latestLocation.latitude;
            event.longitude = latestLocation.longitude;
        } else {
            return res.status(400).json({ error: 'Location unavailable — provide coordinates or post phone GPS first' });
        }
    }

    events.set(event.alertId, event);
    broadcastEvent(event);
    return res.status(201).json(event);
});

app.patch('/api/events/:alertId', (req, res) => {
    const alertId = req.params.alertId;
    const event = events.get(alertId);

    if (!event) {
        return res.status(404).json({ error: 'Event not found' });
    }

    const newStatus = req.body && req.body.status;

    if (newStatus === undefined || newStatus === null) {
        return res.status(400).json({ error: 'Status is required' });
    }

    if (!VALID_STATUSES.includes(newStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const allowed = ALLOWED_TRANSITIONS[event.status] || [];
    if (!allowed.includes(newStatus)) {
        return res.status(409).json({ error: 'Invalid status transition' });
    }

    event.status = newStatus;
    return res.status(200).json(event);
});

app.get('/api/events/stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    sseClients.add(res);
    req.on('close', () => {
        sseClients.delete(res);
    });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
    console.log(`Caretaker backend listening on http://localhost:${PORT}`);
});
