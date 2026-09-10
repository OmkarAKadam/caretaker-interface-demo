'use strict';

const TOPICS = Object.freeze({
    DEVICE_STATUS: 'blindguardian/device/status',
    DEVICE_COMMAND: 'blindguardian/device/command',
    SENSOR_DISTANCE: 'blindguardian/sensor/distance',
    SENSOR_RADAR: 'blindguardian/sensor/radar',
    MOBILE_LOCATION: 'blindguardian/mobile/location',
    MOBILE_FALL: 'blindguardian/mobile/fall',
    EMERGENCY_SOS: 'blindguardian/emergency/sos',
    ALERTS: 'blindguardian/alerts',

    // Heart-rate readings from the ESP32 MAX30102 (MQTT-6).
    SENSOR_HEART: 'blindguardian/sensor/heart'
});

const SUBSCRIBE_TOPICS = Object.freeze([
    TOPICS.DEVICE_STATUS,
    TOPICS.SENSOR_DISTANCE,
    TOPICS.SENSOR_RADAR,
    TOPICS.MOBILE_LOCATION,
    TOPICS.MOBILE_FALL,
    TOPICS.EMERGENCY_SOS,
    TOPICS.ALERTS,
    TOPICS.SENSOR_HEART
]);

module.exports = { TOPICS, SUBSCRIBE_TOPICS };