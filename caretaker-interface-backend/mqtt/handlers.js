'use strict';

function parsePayload(raw) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
        return { ok: false, value: raw };
    }
}

function createMessageHandler(onMessage) {
    return function handleMessage(topic, payloadBuffer) {
        const raw = payloadBuffer ? payloadBuffer.toString() : '';
        const parsed = parsePayload(raw);

        if (!parsed.ok) {
            console.warn('[MQTT] Warning: invalid JSON payload — ignored.');
            console.log(`Topic: ${topic}`);
            console.log(`Payload (raw): ${raw}`);
            return;
        }

        if (typeof onMessage === 'function') {
            onMessage(topic, parsed.value);
            return;
        }

        console.log('[MQTT] Message received');
        console.log(`Topic: ${topic}`);
        console.log(`Payload: ${JSON.stringify(parsed.value)}`);
    };
}

module.exports = { createMessageHandler };