// ============================================
// STEP 9: INTELLIGENT FORWARD RADAR + BUZZER
// ESP32 + HC-SR04 + Buzzer
// ============================================
//
// B-MQTT-3: Added Wi-Fi + secure MQTT publishing (PubSubClient + WiFiClientSecure).
// The cap has a single fixed forward-facing obstacle sensor (no servo panning,
// no left/right scanning): every radar reading is treated as an obstacle AHEAD.
// MQTT publish failures must never stop local obstacle detection.

#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "MAX30105.h"
#include "heartRate.h"


// ============================================
// WI-FI + MQTT CONFIGURATION
// ============================================
//
// NOTE: DO NOT commit real HiveMQ credentials here.
// Replace these placeholders with your own values at flash time.
//
// Wi-Fi
#define WIFI_SSID       "Redmi8"
#define WIFI_PASSWORD   "Omkar9876"

// HiveMQ Cloud TLS broker (mqtts:// -> port 8883)
#define MQTT_HOST       "e0437b73dad44fceb8caea050bbdc398.s1.eu.hivemq.cloud"
#define MQTT_PORT       8883
#define MQTT_USERNAME   "Omkar"
#define MQTT_PASSWORD   "omkar9876"
#define MQTT_CLIENT_ID  "BG001-ESP32"   // must be unique on the broker

#define MQTT_TOPIC_RADAR   "blindguardian/sensor/radar"
#define MQTT_TOPIC_STATUS  "blindguardian/device/status"
#define MQTT_TOPIC_HEART   "blindguardian/sensor/heart"
#define MQTT_TOPIC_COMMAND "blindguardian/device/command"

// Device id reported in payloads
#define DEVICE_ID "BG001"


// ============================================
// PIN CONFIGURATION
// ============================================

#define TRIG_PIN 5
#define ECHO_PIN 18
#define BUZZER_PIN 19

// MAX30102 heart-rate sensor
#define SDA_PIN 21
#define SCL_PIN 22
#define LED_PIN 2


// ============================================
// SETTINGS
// ============================================

// Distance threshold (cm) below which the cap reports an obstacle. Readings
// above this (or a no-echo reading) are CLEAR: no event, no spoken alert.
#define OBSTACLE_DISTANCE 150

// Bounded window to wait for a FRESH MAX30102 beat after a GET_HEART_RATE
// command. Kept to a few heartbeats and well under the backend's request
// timeout: if the window elapses we publish nothing and let the backend time
// out — we never fabricate a BPM.
#define HEART_REQUEST_WAIT_MS 4000


// ============================================
// OBJECTS AND VARIABLES
// ============================================

long duration;
float distance;

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);

unsigned long lastReconnectAttempt = 0;


// ============================================
// MAX30102 HEART-RATE SENSOR
// ============================================

// MAX30105 driver (register-compatible with the MAX30102)
MAX30105 particleSensor;

// The sensor is optional — a missing MAX30102 must not stop the system
bool heartSensorPresent = false;

// MAX30102 algorithm state (used only inside the HR sampling task)
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;

// Heartbeat LED timing (HR task only)
bool ledActive = false;
unsigned long ledOffTime = 0;

// Shared state: written by the HR sampling task, read by the main loop
// for MQTT publishing. The HR task NEVER touches MQTT/WiFi.
volatile bool latestFingerDetected = false;
volatile byte latestHeartRate = 0;
volatile bool newHeartReading = false;

// On-demand GET_HEART_RATE request state.
// Written by the MQTT callback (same core/context as loop()), consumed by the
// main loop. A bounded wait for a FRESH beat guarantees we never reply with a
// stale reading and never block radar for long.
String pendingRequestId = "";
unsigned long requestExpireAt = 0;


// ============================================
// MONITOR HEART RATE (HR TASK ONLY)
// ============================================

void monitorHeartRate() {

  // IR value indicates blood-perfusion / finger presence
  long irValue = particleSensor.getIR();

  // ------------------------------------------
  // FINGER NOT DETECTED
  // ------------------------------------------

  if (irValue < 50000) {

    digitalWrite(LED_PIN, LOW);

    if (latestFingerDetected == true) {

      Serial.println();

      Serial.println("HEART SENSOR: Finger removed");

      latestFingerDetected = false;

    }

    return;

  }

  // ------------------------------------------
  // FINGER DETECTED
  // ------------------------------------------

  if (latestFingerDetected == false) {

    Serial.println();

    Serial.println("HEART SENSOR: Finger detected");

    latestFingerDetected = true;

  }

  // ------------------------------------------
  // HEARTBEAT DETECTION
  // ------------------------------------------

  if (checkForBeat(irValue)) {

    // Heartbeat LED flash
    digitalWrite(LED_PIN, HIGH);

    ledActive = true;

    ledOffTime = millis();

    // Instantaneous BPM from inter-beat interval
    long delta = millis() - lastBeat;

    lastBeat = millis();

    if (delta > 300 && delta < 3000) {

      beatsPerMinute = 60.0 / (delta / 1000.0);

      // Accept realistic BPM
      if (beatsPerMinute > 30 && beatsPerMinute < 220) {

        // Keep the esp2.ino-style ring buffer for diagnostics
        rates[rateSpot++] = (byte)beatsPerMinute;

        rateSpot %= RATE_SIZE;

        beatAvg = 0;

        for (byte i = 0; i < RATE_SIZE; i++) {

          beatAvg += rates[i];

        }

        beatAvg /= RATE_SIZE;

        Serial.println();

        Serial.println("******** HEARTBEAT DETECTED ********");

        Serial.print("Current BPM: ");

        Serial.println(beatsPerMinute);

        // Share the INSTANTANEOUS BPM with the main loop
        // (not the zero-filled ring-buffer average)
        latestHeartRate = (byte)beatsPerMinute;

        newHeartReading = true;

      }

    }

  }

  // ------------------------------------------
  // TURN LED OFF AFTER 80ms
  // ------------------------------------------

  if (ledActive == true) {

    if (millis() - ledOffTime >= 80) {

      digitalWrite(LED_PIN, LOW);

      ledActive = false;

    }

  }

}


// ============================================
// HEART RATE SAMPLING TASK
// ============================================

// FreeRTOS task that samples the MAX30102 ~every 20 ms.
// The main loop is blocked by radar/buzzer/pulseIn(), so the
// heart sensor runs on its own task to avoid missing beats.
// No WiFi / MQTT / PubSubClient access from this task.

void heartRateSamplingTask(void* pvParameters) {

  for (;;) {

    if (heartSensorPresent == true) {

      monitorHeartRate();

    }

    vTaskDelay(20 / portTICK_PERIOD_MS);

  }

}


// ============================================
// SETUP
// ============================================

void setup() {

  Serial.begin(115200);


  // HC-SR04

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);


  // Buzzer

  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);


  // ------------------------------------------
  // MAX30102 HEART-RATE SENSOR (OPTIONAL)
  // ------------------------------------------

  pinMode(LED_PIN, OUTPUT);

  digitalWrite(LED_PIN, LOW);

  Wire.begin(SDA_PIN, SCL_PIN);

  Serial.println();

  Serial.println("Checking MAX30102...");

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {

    Serial.println("MAX30102 NOT FOUND. Heart monitoring disabled (radar/MQTT continue).");

    heartSensorPresent = false;

  }

  else {

    Serial.println("MAX30102 CONNECTED!");

    heartSensorPresent = true;

    particleSensor.setup();

    particleSensor.setPulseAmplitudeRed(0x0A);

    particleSensor.setPulseAmplitudeGreen(0);

  }

  // Dedicated non-blocking heart-rate sampling task
  xTaskCreatePinnedToCore(heartRateSamplingTask, "heartRate", 4096, NULL, 1, NULL, tskNO_AFFINITY);


  Serial.println();

  Serial.println("======================================");
  Serial.println("INTELLIGENT RADAR SYSTEM");
  Serial.println("WITH BUZZER ALERT");
  Serial.println("======================================");

  // ------------------------------------------
  // CONFIGURE MQTT CLIENT
  // ------------------------------------------

  secureClient.setInsecure();  // Dev: accepts any peer cert (HiveMQ Cloud TLS).
                               // For production, pin the HiveMQ CA bundle instead.

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);

  mqttClient.setCallback(mqttCallback);

  // Command payloads (deviceId + requestId + issuedAt) exceed PubSubClient's
  // default 128-byte buffer, so allocate a larger one before connecting.
  mqttClient.setBufferSize(512);

  // ------------------------------------------
  // CONNECT TO WI-FI (non-blocking for local radar)
  // ------------------------------------------

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println();
  Serial.print("Connecting to Wi-Fi");

  unsigned long wifiStart = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {

    delay(500);
    Serial.print(".");

  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    Serial.print("Wi-Fi connected. IP: ");
    Serial.println(WiFi.localIP());

    // Sync real time (needed for ISO-8601 radar timestamps)
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  }

  else {

    Serial.println("Wi-Fi connection failed. Continuing local radar only.");

  }

  // Attempt initial MQTT connection (best effort)
  connectMqtt();

}


// ============================================
// FORMAT ISO-8601 TIMESTAMP FUNCTION
// ============================================
//
// Returns "YYYY-MM-DDTHH:MM:SSZ" in UTC when time is synced.
// Falls back to a stable placeholder if NTP is not ready so the
// payload always stays a valid ISO-8601 string for the backend.

String iso8601Now() {

  time_t now = time(nullptr);
  struct tm tmv = { 0 };
  gmtime_r(&now, &tmv);

  // If RTC/NTP not yet synced (year < 2024), use an explicit placeholder
  if (tmv.tm_year < (2024 - 1900)) {

    return "2026-09-08T09:20:00Z";

  }

  char buffer[24];

  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02dZ",
           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
           tmv.tm_hour, tmv.tm_min, tmv.tm_sec);

  return String(buffer);

}


// ============================================
// GET DANGER LEVEL FUNCTION
// ============================================
//
// Informational `danger` label for the radar MQTT payload. Mirrors the
// severity tiers used by the backend / blind client:
//
//   distance < 0  or > OBSTACLE_DISTANCE -> LOW (clear)
//   distance 91..150                     -> MEDIUM
//   distance 51..90                      -> HIGH
//   distance <= 50                       -> CRITICAL

String getDanger(float distance) {

  if (distance < 0 || distance > OBSTACLE_DISTANCE) {

    return "LOW";

  }

  if (distance <= 50) {

    return "CRITICAL";

  }

  if (distance <= 90) {

    return "HIGH";

  }

  return "MEDIUM";

}


// ============================================
// MQTT CONNECTION FUNCTION
// ============================================

bool connectMqtt() {

  // No point attempting without a network link
  if (WiFi.status() != WL_CONNECTED) {

    return false;

  }

  if (mqttClient.connected()) {

    return true;

  }

  Serial.println();
  Serial.print("Attempting MQTT connection...");

  if (mqttClient.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD)) {

    Serial.println(" connected.");
    mqttClient.subscribe(MQTT_TOPIC_COMMAND);  // on-demand GET_HEART_RATE commands
    publishDeviceStatus("ONLINE", "CONNECTED");

    return true;

  }

  else {

    Serial.print(" failed, state=");
    Serial.print(mqttClient.state());
    Serial.println(" (continuing local radar)");

    return false;

  }

}


// ============================================
// KEEP MQTT PROCESSED (non-blocking) FUNCTION
// ============================================

void maintainMqtt() {

  // Reconnect at most every 5s while disconnected (non-blocking)
  if (!mqttClient.connected()) {

    unsigned long now = millis();

    if (now - lastReconnectAttempt > 5000) {

      lastReconnectAttempt = now;
      connectMqtt();

    }

    return;

  }

  mqttClient.loop();

}


// ============================================
// PUBLISH DEVICE STATUS FUNCTION
// ============================================

void publishDeviceStatus(const char* status, const char* wifiState) {

  if (!mqttClient.connected()) {

    return;

  }

  String payload = String("{\"deviceId\":\"") + DEVICE_ID +
                   "\",\"status\":\"" + status +
                   "\",\"wifi\":\"" + wifiState + "\"}";

  mqttClient.publish(MQTT_TOPIC_STATUS, payload.c_str());

}


// ============================================
// PUBLISH RADAR READING FUNCTION
// ============================================
//
// Single forward-looking radar: no angle, no direction. The backend treats any
// in-range reading as an obstacle AHEAD.

void publishRadarReading(float readingDistance) {

  if (!mqttClient.connected()) {

    // Do not block local safety behavior on the cloud
    return;

  }

  // ISO-8601 UTC timestamp (backend expects a valid Date.parse-able string)
  String timestamp = iso8601Now();

  String payload = String("{\"deviceId\":\"") + DEVICE_ID +
                   "\",\"distance\":" + String(readingDistance, 1) +
                   ",\"danger\":\"" + getDanger(readingDistance) +
                   "\",\"timestamp\":\"" + timestamp + "\"}";

  mqttClient.publish(MQTT_TOPIC_RADAR, payload.c_str());

}


// ============================================
// PUBLISH HEART-RATE READING FUNCTION
// ============================================
//
// Main loop only — never called from the HR sampling task.
// Best effort like publishRadarReading(): skips silently when the
// MQTT client is disconnected or no new beat is available.

void publishHeartReading() {

  if (!heartSensorPresent || !mqttClient.connected()) {

    return;

  }

  if (!newHeartReading || !latestFingerDetected) {

    return;

  }

  newHeartReading = false;

  String timestamp = iso8601Now();

  String payload = String("{\"deviceId\":\"") + DEVICE_ID +
                   "\",\"heartRate\":" + String(latestHeartRate) +
                   ",\"fingerDetected\":" + (latestFingerDetected ? "true" : "false") +
                   ",\"timestamp\":\"" + timestamp + "\"}";

  mqttClient.publish(MQTT_TOPIC_HEART, payload.c_str());

}


// ============================================
// ON-DEMAND GET_HEART_RATE COMMAND HANDLER
// ============================================
//
// Subscribed to blindguardian/device/command. The firmware does not use
// ArduinoJson, so the small flat command payload is parsed with plain String
// scans. Only GET_HEART_RATE commands addressed to THIS device are accepted;
// everything else is ignored.

String extractJsonString(const String& json, const char* key) {

  String token = String("\"") + key + "\":\"";

  int start = json.indexOf(token);

  if (start < 0) {

    return "";

  }

  int valueStart = start + token.length();

  int end = json.indexOf('"', valueStart);

  if (end < 0) {

    return "";

  }

  return json.substring(valueStart, end);

}


void mqttCallback(char* topic, byte* payload, unsigned int length) {

  if (strcmp(topic, MQTT_TOPIC_COMMAND) != 0) {

    return;

  }

  String message;

  message.reserve(length);

  for (unsigned int i = 0; i < length; i++) {

    message += (char)payload[i];

  }

  String command   = extractJsonString(message, "command");
  String device    = extractJsonString(message, "deviceId");
  String requestId = extractJsonString(message, "requestId");

  // Accept ONLY GET_HEART_RATE commands addressed to this device.
  if (command != "GET_HEART_RATE") {

    return;

  }

  if (device != DEVICE_ID) {

    Serial.println("COMMAND: GET_HEART_RATE for another device ignored");

    return;

  }

  if (requestId.length() == 0) {

    Serial.println("COMMAND: GET_HEART_RATE without requestId ignored");

    return;

  }

  Serial.println("COMMAND: GET_HEART_RATE received — waiting for a fresh beat");

  // Consume any beat that predates the command so the response waits for a
  // reading that arrives AFTER the request (never stale data).
  newHeartReading = false;

  pendingRequestId = requestId;

  requestExpireAt = millis() + HEART_REQUEST_WAIT_MS;

}


// ============================================
// PUBLISH HEART-RATE RESPONSE (ON-DEMAND)
// ============================================
//
// Main loop only — never called from the HR sampling task. Echoes the
// incoming requestId so the backend can correlate the response.

void publishHeartReadingWithRequest(const String& requestId) {

  String timestamp = iso8601Now();

  String payload = String("{\"deviceId\":\"") + DEVICE_ID +

                   "\",\"heartRate\":" + String(latestHeartRate) +

                   ",\"fingerDetected\":" + (latestFingerDetected ? "true" : "false") +

                   ",\"timestamp\":\"" + timestamp +

                   "\",\"requestId\":\"" + requestId + "\"}";

  mqttClient.publish(MQTT_TOPIC_HEART, payload.c_str());

}


// ============================================
// HANDLE PENDING GET_HEART_RATE REQUEST
// ============================================
//
// Waits (bounded) for a FRESH beat from the heart-rate sampling task and
// publishes exactly ONE response with the echoed requestId. If no finger / no
// fresh reading arrives within HEART_REQUEST_WAIT_MS, nothing is published —
// no fabricated BPM — and the backend times out instead of trusting fake data.

void handlePendingHeartRequest() {

  if (pendingRequestId.length() == 0) {

    return;

  }

  unsigned long deadline = requestExpireAt;

  while (millis() < deadline) {

    if (newHeartReading && latestFingerDetected) {

      publishHeartReadingWithRequest(pendingRequestId);

      newHeartReading = false;

      pendingRequestId = "";

      Serial.println("COMMAND: GET_HEART_RATE response published (fresh reading)");

      return;

    }

    delay(20);

  }

  pendingRequestId = "";

  Serial.println("COMMAND: GET_HEART_RATE — no fresh reading, NO response published (backend will time out)");

}


// ============================================
// MEASURE DISTANCE FUNCTION
// ============================================

float measureDistance() {

  // Clear trigger

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);


  // Send ultrasonic pulse

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);


  // Read echo

  duration = pulseIn(ECHO_PIN, HIGH, 30000);


  // No echo received

  if (duration == 0) {

    return -1;

  }


  // Calculate distance

  float calculatedDistance;

  calculatedDistance = duration * 0.0343 / 2;


  return calculatedDistance;

}


// ============================================
// BUZZER ALERT FUNCTION
// ============================================

void buzzerAlert(float distance) {


  // ------------------------------------------
  // OUT OF RANGE OR CLEAR
  // ------------------------------------------

  if (distance == -1 || distance > OBSTACLE_DISTANCE) {

    digitalWrite(BUZZER_PIN, LOW);

  }


  // ------------------------------------------
  // 50 - 150 CM
  // SLOW BEEP
  // ------------------------------------------

  else if (distance >= 50 && distance <= OBSTACLE_DISTANCE) {

    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);

    digitalWrite(BUZZER_PIN, LOW);
    delay(350);

  }


  // ------------------------------------------
  // 30 - 49 CM
  // FAST BEEP
  // ------------------------------------------

  else if (distance >= 30) {

    digitalWrite(BUZZER_PIN, HIGH);
    delay(120);

    digitalWrite(BUZZER_PIN, LOW);
    delay(120);

  }


  // ------------------------------------------
  // BELOW 30 CM
  // CONTINUOUS BEEP
  // ------------------------------------------

  else {

    digitalWrite(BUZZER_PIN, HIGH);
    delay(400);

    digitalWrite(BUZZER_PIN, LOW);

  }

}


// ============================================
// PROCESS RADAR READING
// ============================================
//
// Single fixed forward reading: measure, print, buzz, publish.

void processReading() {


  // Measure distance

  distance = measureDistance();


  // ------------------------------------------
  // DISPLAY SCAN INFORMATION
  // ------------------------------------------

  Serial.println("--------------------------------------");


  // ------------------------------------------
  // CHECK DISTANCE
  // ------------------------------------------

  if (distance == -1) {

    Serial.println("Distance: Out of Range");

    Serial.println("Status: CLEAR");

  }

  else {

    Serial.print("Distance: ");
    Serial.print(distance);
    Serial.println(" cm");


    // ----------------------------------------
    // CHECK OBSTACLE
    // ----------------------------------------

    if (distance <= OBSTACLE_DISTANCE) {

      Serial.println("STATUS: OBSTACLE DETECTED!");


      if (distance < 50) {

        Serial.println("WARNING: CLOSE DANGER!");

      }

      else {

        Serial.println("WARNING: OBSTACLE AHEAD");

      }

    }

    else {

      Serial.println("Status: CLEAR");

    }

  }


  // ------------------------------------------
  // ACTIVATE BUZZER
  // ------------------------------------------

  buzzerAlert(distance);


  // ------------------------------------------
  // PUBLISH RADAR READING (MQTT, best effort)
  // ------------------------------------------
  //
  // One publish per processed reading after the measurement is
  // complete. If MQTT is disconnected this is a no-op, so local
  // obstacle detection is never blocked by the cloud.

  publishRadarReading(distance);

}


// ============================================
// MAIN LOOP
// ============================================

void loop() {


  // ==========================================
  // KEEP MQTT ALIVE (non-blocking, best effort)
  // ==========================================
  //
  // Reconnects and pumps the MQTT client without blocking the
  // radar scan. Returns immediately when disconnected.

  maintainMqtt();


  // ==========================================
  // HANDLE ON-DEMAND GET_HEART_RATE REQUEST (MQTT, best effort)
  // ==========================================
  //
  // Publishes ONE response with the echoed requestId once a fresh beat is
  // available, or silently times out (publishing nothing) if no finger / no
  // fresh reading arrives. Runs before the continuous publisher so the
  // response beat is never double-published.

  handlePendingHeartRequest();


  // ==========================================
  // PUBLISH HEART-RATE READING (MQTT, best effort)
  // ==========================================

  publishHeartReading();


  // ==========================================
  // FORWARD RADAR READING
  // ==========================================
  //
  // No servo panning: a single fixed forward reading per cycle, paced by a
  // short delay so the main loop never hammers the sensor or the MQTT client.

  processReading();

  delay(250);

}