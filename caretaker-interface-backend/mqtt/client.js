'use strict';

const mqtt = require('mqtt');
const crypto = require('crypto');

const { SUBSCRIBE_TOPICS } = require('./topics');
const { createMessageHandler } = require('./handlers');

const DEFAULT_CLIENT_ID_PREFIX = 'caretaker-backend';
const SUBSCRIBE_QOS = 0;
const RECONNECT_PERIOD_MS = 5000;
const CONNECT_TIMEOUT_MS = 15000;

function getConfig() {
    return {
        brokerUrl: process.env.MQTT_BROKER_URL,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        clientId:
            process.env.MQTT_CLIENT_ID ||
            `${DEFAULT_CLIENT_ID_PREFIX}-${crypto.randomBytes(4).toString('hex')}`
    };
}

function isConfigured(config) {
    return Boolean(config.brokerUrl);
}

function createMqttClient(onMessage) {
    const config = getConfig();

    if (!isConfigured(config)) {
        console.warn(
            '[MQTT] MQTT is not configured — MQTT_BROKER_URL is missing. ' +
            'The REST server continues without MQTT. ' +
            'Set MQTT_BROKER_URL (and MQTT_USERNAME/MQTT_PASSWORD for HiveMQ Cloud) to enable it.'
        );
        return {
            client: null,
            getState: () => 'disabled',
            publish: () => false,
            close: () => {}
        };
    }

    let state = 'connecting';
    let client = null;
    let lastError = null;

    function setState(nextState, error) {
        state = nextState;
        if (error) lastError = error;
    }

    const connectOptions = {
        clientId: config.clientId,
        username: config.username || undefined,
        password: config.password || undefined,
        reconnectPeriod: RECONNECT_PERIOD_MS,
        connectTimeout: CONNECT_TIMEOUT_MS,
        clean: true,
        rejectUnauthorized: true
    };

    try {
        client = mqtt.connect(config.brokerUrl, connectOptions);
    } catch (err) {
        console.error(`[MQTT] Failed to create MQTT client: ${err.message || err}`);
        return {
            client: null,
            getState: () => 'error',
            publish: () => false,
            close: () => {}
        };
    }

    const handleMessage = createMessageHandler(onMessage);

    client.on('connect', () => {
        setState('connected');
        console.log(`[MQTT] Connected to ${config.brokerUrl} as "${config.clientId}"`);
        client.subscribe(SUBSCRIBE_TOPICS, { qos: SUBSCRIBE_QOS }, (err, granted) => {
            if (err) {
                console.error(`[MQTT] Subscribe error: ${err.message || err}`);
                return;
            }
            const topics = Array.isArray(granted)
                ? granted.map((g) => `${g.topic} (qos ${g.qos})`).join(', ')
                : SUBSCRIBE_TOPICS.join(', ');
            console.log(`[MQTT] Subscribed: ${topics}`);
        });
    });

    client.on('reconnect', () => {
        setState('reconnecting');
        console.warn('[MQTT] Reconnecting…');
    });

    client.on('offline', () => {
        console.warn('[MQTT] Client offline.');
    });

    client.on('close', () => {
        setState(state === 'connected' || state === 'reconnecting' ? 'disconnected' : state);
        console.warn('[MQTT] Connection closed.');
    });

    client.on('error', (err) => {
        setState('error', err);
        console.error(`[MQTT] Connection error: ${err.message || err}`);
    });

    client.on('message', (topic, payloadBuffer) => {
        try {
            handleMessage(topic, payloadBuffer);
        } catch (err) {
            console.error(`[MQTT] Message handler error: ${err.message || err}`);
        }
    });

    function publish(topic, payload, options) {
        if (!client || client.connected !== true) {
            console.warn(`[MQTT] Publish skipped on "${topic}" — client not connected.`);
            return false;
        }
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const opts = options || { qos: 0, retain: false };
        client.publish(topic, data, opts, (err) => {
            if (err) {
                console.error(`[MQTT] Publish error on "${topic}": ${err.message || err}`);
            } else {
                console.log(`[MQTT] Published to "${topic}": ${data}`);
            }
        });
        return true;
    }

    function close() {
        if (!client) return;
        try {
            client.end(true, () => console.log('[MQTT] Disconnected on shutdown.'));
        } catch (err) {
            console.error(`[MQTT] Error during shutdown disconnect: ${err.message || err}`);
        }
    }

    return {
        client,
        getState: () => state,
        publish,
        close
    };
}

module.exports = { createMqttClient };