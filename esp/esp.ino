// ============================================================
// BLIND GUARDIAN - FINAL ESP32 SENSOR SYSTEM
// ============================================================
//
// HARDWARE
// ------------------------------------------------------------
// ESP32
// HC-SR04 Ultrasonic Sensor
// Buzzer
// MAX30102 Heart Rate Sensor
//
// NO SERVO
//
// FEATURES
// ------------------------------------------------------------
// 1. HC-SR04 continuously monitors distance
//
// 2. BUZZER (aligned to the backend obstacle bands):
//      > 150 cm       -> SILENT (clear)
//      91-150 cm      -> SLOW / MEDIUM warning
//      51-90 cm       -> FASTER warning
//      <= 50 cm       -> CONTINUOUS / urgent warning
//
// 3. HEART RATE:
//      Device boots
//          ↓
//      MAX30102 initializes
//          ↓
//      Wi-Fi connects
//          ↓
//      MQTT connects
//          ↓
//      DEVICE ONLINE
//          ↓
//      Immediately start 30-second HR session
//          ↓
//      Send valid BPM samples to MQTT
//          ↓
//      Session ends
//          ↓
//      Wait 2 minutes
//          ↓
//      Start next 30-second HR session
//          ↓
//      Repeat forever
//
// 4. ON-DEMAND HEART RATE (GET_HEART_RATE):
//      Subscribes to blindguardian/device/command.
//      A GET_HEART_RATE command addressed to THIS device
//      produces exactly ONE fresh reading, echoing the
//      requestId, published to blindguardian/sensor/heart.
//
// 5. SERVER:
//      Receives raw valid BPM samples.
//      Server can remove invalid/outlier values
//      and calculate final average BPM.
//
// 6. MQTT over TLS
// 7. Wi-Fi + MQTT automatic reconnect
// 8. MAX30102 runs on separate FreeRTOS task
// 9. NTP-gated publishing (no 1970 timestamps)
// 10. No Servo
//
// ============================================================


#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <string.h>

#include "MAX30105.h"
#include "heartRate.h"


// ============================================================
// WIFI CONFIGURATION
// ============================================================

#define WIFI_SSID       "MG"
#define WIFI_PASSWORD   "12345678"


// ============================================================
// MQTT CONFIGURATION
// ============================================================

#define MQTT_HOST       "e0437b73dad44fceb8caea050bbdc398.s1.eu.hivemq.cloud"
#define MQTT_PORT       8883
#define MQTT_USERNAME   "Omkar"
#define MQTT_PASSWORD   "omkar9876"

#define MQTT_CLIENT_ID  "BG001-ESP32"


// ============================================================
// MQTT TOPICS
// ============================================================

#define MQTT_TOPIC_RADAR   "blindguardian/sensor/radar"
#define MQTT_TOPIC_STATUS  "blindguardian/device/status"
#define MQTT_TOPIC_HEART   "blindguardian/sensor/heart"
#define MQTT_TOPIC_COMMAND "blindguardian/device/command"


// ============================================================
// DEVICE ID
// ============================================================

#define DEVICE_ID "BG001"


// ============================================================
// PIN CONFIGURATION
// ============================================================

// HC-SR04
#define TRIG_PIN 5
#define ECHO_PIN 18

// Buzzer
#define BUZZER_PIN 19

// MAX30102
#define SDA_PIN 21
#define SCL_PIN 22

// ESP32 onboard LED
#define LED_PIN 2


// ============================================================
// DISTANCE SETTINGS
// ============================================================

#define MAX_DISTANCE_CM 400

// Buzzer thresholds (aligned to backend obstacle bands)
#define WARNING_SILENT_MIN_CM   151   // > 150 cm -> silent
#define MODERATE_MIN_CM         91    // 91-150 cm -> slow/medium warning
#define CLOSE_MIN_CM            51    // 51-90 cm -> faster warning
#define VERY_CLOSE_MAX_CM       50    // <= 50 cm -> continuous/urgent


// ============================================================
// HEART RATE SETTINGS
// ============================================================

// Wait 2 minutes between heart-rate sessions
#define HEART_INTERVAL_MS 120000UL

// Each heart-rate measurement session = 30 seconds
#define HEART_SESSION_MS 30000UL

// Finger detection threshold
#define IR_FINGER_THRESHOLD 50000


// ============================================================
// OBJECTS
// ============================================================

MAX30105 particleSensor;

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);


// ============================================================
// WIFI / MQTT STATE
// ============================================================

unsigned long lastReconnectAttempt = 0;

// Non-blocking Wi-Fi reconnect cadence.
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 10000UL;
unsigned long lastWifiReconnectAttempt = 0;

// NTP re-sync cadence until the clock is valid.
const unsigned long NTP_RETRY_INTERVAL_MS = 30000UL;
unsigned long lastNtpAttempt = 0;


// ============================================================
// DISTANCE STATE
// ============================================================

float currentDistance = -1;

// Radar publish pacing (main loop cadence).
const unsigned long RADAR_PUBLISH_INTERVAL_MS = 200UL;
unsigned long lastRadarPublishMs = 0;


// ============================================================
// HEART SENSOR STATE
// ============================================================

bool heartSensorPresent = false;

volatile bool heartSessionActive = false;

volatile bool fingerDetected = false;

volatile unsigned long heartSessionStart = 0;

volatile unsigned long lastHeartSession = 0;


// ============================================================
// HEART RATE ALGORITHM
// ============================================================

// Touched from both the MQTT callback and the heart-rate task.
volatile long lastBeat = 0;

volatile float currentBPM = 0;


// ============================================================
// HEART SESSION
// ============================================================

unsigned long heartSessionId = 0;


// ============================================================
// FIRST HEART SESSION CONTROL
// ============================================================

// This becomes true ONLY after MQTT successfully connects.
volatile bool heartMonitoringReady = false;

// ============================================================
// ON-DEMAND GET_HEART_RATE COMMAND STATE
// ============================================================

// A GET_HEART_RATE command addressed to this device, awaiting a fresh beat.
volatile bool commandPending = false;

// Echoed requestId that must be returned with the response.
String pendingRequestId = "";

// Guards against duplicate responses for one command.
volatile bool commandResponseSent = false;

// Time the pending command started, for the fresh-reading deadline.
volatile unsigned long commandReceivedAtMs = 0;

// True while an ONLINE status still needs to be (re)sent after connect;
// cleared once it is published. Guards against losing ONLINE when NTP
// has not synced yet at connect time.
volatile bool onlineStatusPending = false;

// Max time to wait for a fresh beat before abandoning the command
// (backend timeout is 15 s).
#define COMMAND_READ_TIMEOUT_MS 15000UL


// ============================================================
// TIMESTAMP / NTP
// ============================================================

// True once NTP has produced a valid wall-clock time. Anything earlier
// than 2024 is treated as the unsynced 1970-01-01 placeholder.
bool isTimeSynced() {

  time_t now = time(nullptr);

  return now > (time_t)1704067200; // 2024-01-01

}

// Re-arms NTP synchronization without blocking. Safe to call repeatedly
// while never synced.
void syncSystemTime() {

  configTime(
    0,
    0,
    "pool.ntp.org",
    "time.nist.gov"
  );

}

String iso8601Now() {

  if (!isTimeSynced()) {

    // Never publish an invalid / stale timestamp.
    return "";

  }

  time_t now = time(nullptr);

  struct tm tmv = {0};

  gmtime_r(&now, &tmv);


  char buffer[30];


  snprintf(
    buffer,
    sizeof(buffer),
    "%04d-%02d-%02dT%02d:%02d:%02dZ",
    tmv.tm_year + 1900,
    tmv.tm_mon + 1,
    tmv.tm_mday,
    tmv.tm_hour,
    tmv.tm_min,
    tmv.tm_sec
  );


  return String(buffer);
}


// ============================================================
// DEVICE STATUS
// ============================================================

void publishDeviceStatus(
  const char* status,
  const char* wifiState
) {

  if (!mqttClient.connected()) {

    return;

  }


  // Never publish a 1970/empty timestamp; retry once time syncs.
  if (!isTimeSynced()) {

    return;

  }


  String payload =
    String("{\"deviceId\":\"") +
    DEVICE_ID +
    "\",\"status\":\"" +
    status +
    "\",\"wifi\":\"" +
    wifiState +
    "\",\"timestamp\":\"" +
    iso8601Now() +
    "\"}";


  bool published =
    mqttClient.publish(
      MQTT_TOPIC_STATUS,
      payload.c_str()
    );

  if (
    published &&
    onlineStatusPending &&
    strcmp(
      status,
      "ONLINE"
    ) == 0
  ) {

    onlineStatusPending =
      false;
  }
}


// ============================================================
// START HEART SESSION
// ============================================================

void startHeartSession() {

  if (!heartSensorPresent) {

    Serial.println(
      "Heart session skipped: MAX30102 not available."
    );

    return;
  }


  if (!mqttClient.connected()) {

    Serial.println(
      "Heart session skipped: MQTT not connected."
    );

    return;
  }


  if (heartSessionActive) {

    return;
  }


  heartSessionActive = true;

  heartSessionStart = millis();

  heartSessionId++;


  // Reset beat detection
  lastBeat = 0;

  currentBPM = 0;

  fingerDetected = false;


  Serial.println();
  Serial.println(
    "================================================"
  );

  Serial.println(
    "❤️ HEART RATE SESSION STARTED"
  );

  Serial.print(
    "Session ID: "
  );

  Serial.println(
    heartSessionId
  );

  Serial.println(
    "Duration: 30 seconds"
  );

  Serial.println(
    "Place finger on MAX30102..."
  );

  Serial.println(
    "================================================"
  );
}


// ============================================================
// END HEART SESSION
// ============================================================

void endHeartSession() {

  if (!heartSessionActive) {

    return;
  }


  heartSessionActive = false;

  lastHeartSession = millis();


  digitalWrite(
    LED_PIN,
    LOW
  );


  Serial.println();
  Serial.println(
    "================================================"
  );

  Serial.println(
    "❤️ HEART RATE SESSION FINISHED"
  );

  Serial.print(
    "Session ID: "
  );

  Serial.println(
    heartSessionId
  );

  Serial.println(
    "Waiting 2 minutes for next session..."
  );

  Serial.println(
    "================================================"
  );
}


// ============================================================
// MQTT CONNECTION
// ============================================================

bool connectMqtt() {

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    return false;
  }


  if (
    mqttClient.connected()
  ) {

    return true;
  }


  Serial.println();
  Serial.print(
    "Connecting to MQTT..."
  );


  if (
    mqttClient.connect(
      MQTT_CLIENT_ID,
      MQTT_USERNAME,
      MQTT_PASSWORD
    )
  ) {

    Serial.println(
      " CONNECTED"
    );


    // --------------------------------------------------------
    // SUBSCRIBE TO COMMANDS (GET_HEART_RATE etc.)
    // --------------------------------------------------------

    mqttClient.subscribe(
      MQTT_TOPIC_COMMAND
    );


    Serial.println(
      "Subscribed to blindguardian/device/command."
    );


    // --------------------------------------------------------
    // DEVICE ONLINE
    // --------------------------------------------------------

    onlineStatusPending = true;

    publishDeviceStatus(
      "ONLINE",
      "CONNECTED"
    );


    // --------------------------------------------------------
    // MQTT IS NOW READY FOR HEART DATA
    // --------------------------------------------------------

    heartMonitoringReady = true;


    // --------------------------------------------------------
    // START FIRST HEART SESSION IMMEDIATELY
    // (skipped while an on-demand command is pending so the
    //  response stays unambiguous)
    // --------------------------------------------------------

    if (
      heartSensorPresent &&
      !heartSessionActive &&
      !commandPending
    ) {

      Serial.println();
      Serial.println(
        "MQTT connected successfully."
      );

      Serial.println(
        "Starting first heart-rate check..."
      );


      // Make first session start immediately
      lastHeartSession =
        millis() - HEART_INTERVAL_MS;


      startHeartSession();
    }


    return true;
  }


  Serial.print(
    " FAILED. MQTT state = "
  );

  Serial.println(
    mqttClient.state()
  );


  return false;
}


// ============================================================
// MQTT MAINTENANCE
// ============================================================

void maintainMqtt() {

  // ----------------------------------------------------------
  // MQTT DISCONNECTED
  // ----------------------------------------------------------

  if (
    !mqttClient.connected()
  ) {

    // Stop active heart session
    // because server is unavailable.
    if (
      heartSessionActive
    ) {

      Serial.println(
        "MQTT disconnected - stopping heart session."
      );

      endHeartSession();
    }


    heartMonitoringReady = false;


    unsigned long now =
      millis();


    if (
      now - lastReconnectAttempt >= 5000
    ) {

      lastReconnectAttempt =
        now;


      connectMqtt();
    }


    return;
  }


  // ----------------------------------------------------------
  // MQTT LOOP
  // ----------------------------------------------------------

  mqttClient.loop();
}


// ============================================================
// DISTANCE MEASUREMENT
// ============================================================

float measureDistance() {

  // Clear trigger
  digitalWrite(
    TRIG_PIN,
    LOW
  );

  delayMicroseconds(2);


  // Send 10us trigger pulse
  digitalWrite(
    TRIG_PIN,
    HIGH
  );

  delayMicroseconds(10);

  digitalWrite(
    TRIG_PIN,
    LOW
  );


  // Read echo
  unsigned long duration =
    pulseIn(
      ECHO_PIN,
      HIGH,
      30000
    );


  // No echo
  if (
    duration == 0
  ) {

    return -1;
  }


  // Calculate distance
  float distance =
    duration * 0.0343 / 2.0;


  // Validate
  if (
    distance <= 0 ||
    distance > MAX_DISTANCE_CM
  ) {

    return -1;
  }


  return distance;
}


// ============================================================
// RADAR / DISTANCE MQTT
// ============================================================

void publishDistanceReading(
  float distance
) {

  if (
    !mqttClient.connected()
  ) {

    return;
  }


  // Never publish a 1970/empty timestamp.
  if (
    !isTimeSynced()
  ) {

    return;
  }


  String danger;


  if (
    distance < 0
  ) {

    danger = "CLEAR";

  }
  else if (
    distance <= 100
  ) {

    danger = "CRITICAL";

  }
  else if (
    distance <= 150
  ) {

    danger = "HIGH";

  }
  else if (
    distance <= 200
  ) {

    danger = "MEDIUM";

  }
  else {

    danger = "LOW";
  }


  String payload =
    String("{\"deviceId\":\"") +
    DEVICE_ID +
    "\",\"distance\":" +
    String(distance, 1) +
    ",\"danger\":\"" +
    danger +
    "\",\"timestamp\":\"" +
    iso8601Now() +
    "\"}";


  mqttClient.publish(
    MQTT_TOPIC_RADAR,
    payload.c_str()
  );
}


// ============================================================
// BUZZER CONTROL
// ============================================================

void buzzerControl(
  float distance
) {

  // ----------------------------------------------------------
  // CLEAR / OUT OF RANGE / > 150 cm: SILENT
  // ----------------------------------------------------------

  if (
    distance < 0 ||
    distance >= WARNING_SILENT_MIN_CM
  ) {

    digitalWrite(
      BUZZER_PIN,
      LOW
    );

    return;
  }


  // ----------------------------------------------------------
  // VERY CLOSE: <= 50 cm -> CONTINUOUS / urgent
  // ----------------------------------------------------------

  if (
    distance <= VERY_CLOSE_MAX_CM
  ) {

    digitalWrite(
      BUZZER_PIN,
      HIGH
    );

    delay(40); // brief non-blocking pause so the loop keeps processing

    return;
  }


  // ----------------------------------------------------------
  // CLOSE: 51 - 90 cm -> FASTER warning
  // ----------------------------------------------------------

  if (
    distance < CLOSE_MIN_CM
  ) {

    digitalWrite(
      BUZZER_PIN,
      HIGH
    );

    delay(60);

    digitalWrite(
      BUZZER_PIN,
      LOW
    );

    delay(140);

    return;
  }


  // ----------------------------------------------------------
  // MODERATE: 91 - 150 cm -> SLOW / MEDIUM warning
  // ----------------------------------------------------------

  digitalWrite(
    BUZZER_PIN,
    HIGH
  );

  delay(80);

  digitalWrite(
    BUZZER_PIN,
    LOW
  );

  delay(220);

  return;
}


// ============================================================
// HEART SENSOR SETUP
// ============================================================

void setupHeartSensor() {

  pinMode(
    LED_PIN,
    OUTPUT
  );

  digitalWrite(
    LED_PIN,
    LOW
  );


  // ----------------------------------------------------------
  // I2C
  // ----------------------------------------------------------

  Wire.begin(
    SDA_PIN,
    SCL_PIN
  );


  Serial.println();
  Serial.println(
    "Checking MAX30102..."
  );


  // ----------------------------------------------------------
  // SENSOR DETECTION
  // ----------------------------------------------------------

  if (
    !particleSensor.begin(
      Wire,
      I2C_SPEED_FAST
    )
  ) {

    Serial.println(
      "MAX30102 NOT FOUND."
    );

    Serial.println(
      "Heart monitoring disabled."
    );


    heartSensorPresent =
      false;


    return;
  }


  Serial.println(
    "MAX30102 CONNECTED!"
  );


  heartSensorPresent =
    true;


  // ----------------------------------------------------------
  // MAX30102 CONFIGURATION
  // ----------------------------------------------------------

  particleSensor.setup();


  // RED LED
  particleSensor.setPulseAmplitudeRed(
    0x0A
  );


  // Disable GREEN LED
  particleSensor.setPulseAmplitudeGreen(
    0
  );


  // ----------------------------------------------------------
  // IMPORTANT
  // ----------------------------------------------------------
  // Do NOT start the heart session here.
  //
  // First session will start only after
  // Wi-Fi + MQTT are successfully connected.
  // ----------------------------------------------------------

  lastHeartSession =
    millis();
}


// ============================================================
// PUBLISH HEART SAMPLE
// ============================================================
//
// ESP32 sends valid detected BPM samples.
//
// Server should:
// 1. Group samples using sessionId
// 2. Remove invalid/outlier values
// 3. Calculate average BPM
// 4. Store final timestamp + average BPM
//
// ============================================================

void publishHeartSample(
  float bpm
) {

  if (
    !mqttClient.connected() ||
    !isTimeSynced()
  ) {

    // Never publish an invalid (empty / 1970) timestamp.
    return;
  }


  String payload =
    String("{\"deviceId\":\"") +
    DEVICE_ID +
    "\",\"sessionId\":" +
    String(heartSessionId) +
    ",\"heartRate\":" +
    String(bpm, 1) +
    ",\"timestamp\":\"" +
    iso8601Now() +
    "\",\"sessionActive\":true}";


  bool success =
    mqttClient.publish(
      MQTT_TOPIC_HEART,
      payload.c_str()
    );


  if (
    success
  ) {

    Serial.print(
      "❤️ HR sample sent: "
    );

    Serial.print(
      bpm,
      1
    );

    Serial.println(
      " BPM"
    );

  }
  else {

    Serial.println(
      "❌ Failed to send HR sample."
    );
  }
}


// ============================================================
// JSON VALUE EXTRACTOR
// ============================================================

// Pulls the string value for a key from a small JSON object.
String extractJsonString(
  const String& json,
  const String& key
) {

  String marker =
    "\"" + key + "\":\"";

  int start =
    json.indexOf(marker);

  if (
    start < 0
  ) {

    return "";

  }

  start += marker.length();

  int end =
    json.indexOf(
      '"',
      start
    );

  if (
    end < 0
  ) {

    return "";

  }

  return json.substring(
    start,
    end
  );
}


// ============================================================
// MQTT COMMAND CALLBACK
// ============================================================

void mqttCallback(
  char* topic,
  byte* payload,
  unsigned int length
) {

  if (
    strcmp(
      topic,
      MQTT_TOPIC_COMMAND
    ) != 0
  ) {

    return;
  }

  if (
    payload == NULL ||
    length == 0
  ) {

    return;
  }


  // Build a null-terminated copy.
  char message[300];

  if (
    length >= sizeof(message)
  ) {

    length = sizeof(message) - 1;

  }

  memcpy(
    message,
    payload,
    length
  );

  message[length] = '\0';

  String cmdStr =
    extractJsonString(
      message,
      "command"
    );

  String cmdDeviceId =
    extractJsonString(
      message,
      "deviceId"
    );

  String cmdRequestId =
    extractJsonString(
      message,
      "requestId"
    );


  // Ignore anything that is not a GET_HEART_RATE for THIS device.
  if (
    cmdStr != "GET_HEART_RATE"
  ) {

    return;
  }

  if (
    cmdDeviceId != DEVICE_ID
  ) {

    Serial.println(
      "COMMAND: GET_HEART_RATE for another device ignored."
    );

    return;
  }

  if (
    cmdRequestId.length() == 0
  ) {

    Serial.println(
      "COMMAND: GET_HEART_RATE without requestId ignored."
    );

    return;
  }


  // A command is already being answered — never answer it more than once.
  if (
    commandPending
  ) {

    Serial.println(
      "COMMAND: GET_HEART_RATE already pending — duplicate ignored."
    );

    return;
  }


  // Begin a fresh, on-demand reading session.
  commandPending = true;

  commandResponseSent = false;

  commandReceivedAtMs = millis();

  pendingRequestId = cmdRequestId;


  // Require a FRESH beat after the command arrived; reset detection.
  lastBeat = 0;

  currentBPM = 0;

  fingerDetected = false;


  // Stop any running continuous session so the two flows never collide.
  if (
    heartSessionActive
  ) {

    endHeartSession();

  }


  Serial.print(
    "COMMAND: GET_HEART_RATE received (requestId "
  );

  Serial.print(
    pendingRequestId
  );

  Serial.println(
    ") — awaiting fresh beat."
  );
}


// ============================================================
// ON-DEMAND HEART READING (GET_HEART_RATE response)
// ============================================================

// Publishes EXACTLY ONE response for a command, echoing the original
// requestId, to blindguardian/sensor/heart.
void publishCommandResponse() {

  if (
    !commandPending
  ) {

    return;
  }

  // Capture the requestId first so the callback cannot overwrite it
  // while this task is building the payload.
  String responseRequestId =
    pendingRequestId;

  commandPending = false;

  if (
    commandResponseSent
  ) {

    return;
  }

  commandResponseSent = true;


  if (
    !mqttClient.connected() ||
    !isTimeSynced()
  ) {

    Serial.println(
      "COMMAND: response NOT sent (MQTT/time unavailable)."
    );

    return;
  }


  String payload =
    String("{\"deviceId\":\"") +
    DEVICE_ID +
    "\",\"heartRate\":" +
    String(currentBPM, 1) +
    ",\"timestamp\":\"" +
    iso8601Now() +
    "\",\"requestId\":\"" +
    responseRequestId +
    "\",\"sessionActive\":false}";


  bool success =
    mqttClient.publish(
      MQTT_TOPIC_HEART,
      payload.c_str()
    );


  if (
    success
  ) {

    Serial.println(
      "COMMAND: GET_HEART_RATE response published."
    );

  }
  else {

    Serial.println(
      "COMMAND: GET_HEART_RATE response publish FAILED."
    );

  }
}


// ============================================================
// HEART RATE MONITOR
// ============================================================

void monitorHeartRate() {

  if (
    !heartSensorPresent
  ) {

    return;
  }


  // ----------------------------------------------------------
  // Read IR signal
  // ----------------------------------------------------------

  long irValue =
    particleSensor.getIR();


  // ----------------------------------------------------------
  // FINGER NOT DETECTED
  // ----------------------------------------------------------

  if (
    irValue < IR_FINGER_THRESHOLD
  ) {

    if (
      fingerDetected
    ) {

      Serial.println(
        "Heart Sensor: Finger removed."
      );
    }


    fingerDetected =
      false;


    digitalWrite(
      LED_PIN,
      LOW
    );


    return;
  }


  // ----------------------------------------------------------
  // FINGER DETECTED
  // ----------------------------------------------------------

  if (
    !fingerDetected
  ) {

    fingerDetected =
      true;


    Serial.println(
      "Heart Sensor: Finger detected."
    );
  }


  // ----------------------------------------------------------
  // HEARTBEAT DETECTION
  // ----------------------------------------------------------

  if (
    checkForBeat(irValue)
  ) {

    digitalWrite(
      LED_PIN,
      HIGH
    );


    unsigned long now =
      millis();


    // --------------------------------------------------------
    // First detected beat
    // --------------------------------------------------------

    if (
      lastBeat == 0
    ) {

      lastBeat =
        now;

      return;
    }


    // --------------------------------------------------------
    // Time between beats
    // --------------------------------------------------------

    long delta =
      now - lastBeat;


    lastBeat =
      now;


    // --------------------------------------------------------
    // Valid beat interval
    //
    // 300 ms = 200 BPM
    // 2000 ms = 30 BPM
    // --------------------------------------------------------

    if (
      delta >= 300 &&
      delta <= 2000
    ) {

      float bpm =
        60000.0 / delta;


      // ------------------------------------------------------
      // Valid BPM range
      // ------------------------------------------------------

      if (
        bpm >= 30 &&
        bpm <= 220
      ) {

        currentBPM =
          bpm;


        Serial.print(
          "Detected BPM: "
        );

        Serial.println(
          bpm,
          1
        );


        // ----------------------------------------------------
        // SEND THE READING
        // ----------------------------------------------------

        if (
          commandPending
        ) {

          // Exactly ONE response that answers the GET_HEART_RATE command.
          publishCommandResponse();

        }
        else if (
          heartSessionActive &&
          mqttClient.connected()
        ) {

          publishHeartSample(
            bpm
          );
        }
      }
    }
  }


  // ----------------------------------------------------------
  // Heartbeat LED
  // ----------------------------------------------------------

  delay(30);


  digitalWrite(
    LED_PIN,
    LOW
  );
}


// ============================================================
// HEART RATE FREERTOS TASK
// ============================================================

void heartRateTask(
  void* parameter
) {

  for (;;) {

    // ========================================================
    // ABANDON A STALE GET_HEART_RATE COMMAND (deadline hit)
    // Runs regardless of connection state so the pending command
    // always clears and continuous monitoring can resume.
    // ========================================================

    if (
      commandPending &&
      millis() - commandReceivedAtMs >= COMMAND_READ_TIMEOUT_MS
    ) {

      Serial.println(
        "COMMAND: GET_HEART_RATE timed out — no fresh reading."
      );

      commandPending = false;

      pendingRequestId = "";
    }


    // ========================================================
    // HEART MONITORING ONLY AVAILABLE AFTER MQTT CONNECTION
    // ========================================================

    if (
      heartMonitoringReady &&
      heartSensorPresent &&
      mqttClient.connected()
    ) {

      // ------------------------------------------------------
      // START NEXT SESSION AFTER 2 MINUTES
      // (skipped while an on-demand command is being answered)
      // ------------------------------------------------------

      if (
        !commandPending &&
        !heartSessionActive &&
        millis() - lastHeartSession >= HEART_INTERVAL_MS
      ) {

        startHeartSession();
      }


      // ------------------------------------------------------
      // ACTIVE 30-SECOND SESSION
      // ------------------------------------------------------

      if (
        heartSessionActive
      ) {

        if (
          millis() - heartSessionStart >= HEART_SESSION_MS
        ) {

          endHeartSession();

        }
        else {

          monitorHeartRate();
        }

      }


      // ------------------------------------------------------
      // PENDING COMMAND — keep sampling for a fresh beat
      // ------------------------------------------------------

      if (
        commandPending
      ) {

        monitorHeartRate();
      }
    }


    // --------------------------------------------------------
    // Task delay
    // --------------------------------------------------------

    vTaskDelay(
      20 / portTICK_PERIOD_MS
    );
  }
}


// ============================================================
// WIFI CONNECTION
// ============================================================

bool connectWiFi() {

  WiFi.mode(
    WIFI_STA
  );


  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );


  Serial.println();
  Serial.print(
    "Connecting to Wi-Fi"
  );


  unsigned long wifiStart =
    millis();


  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - wifiStart < 15000
  ) {

    delay(500);

    Serial.print(
      "."
    );
  }


  Serial.println();


  if (
    WiFi.status() == WL_CONNECTED
  ) {

    Serial.println(
      "Wi-Fi connected!"
    );


    Serial.print(
      "ESP32 IP: "
    );

    Serial.println(
      WiFi.localIP()
    );


    // --------------------------------------------------------
    // NTP
    // --------------------------------------------------------

    syncSystemTime();

    lastNtpAttempt = 0;


    return true;
  }


  Serial.println(
    "Wi-Fi connection failed."
  );


  return false;
}


// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(
    115200
  );


  delay(1000);


  Serial.println();
  Serial.println(
    "================================================"
  );

  Serial.println(
    "        BLIND GUARDIAN SENSOR SYSTEM"
  );

  Serial.println(
    "================================================"
  );

  Serial.println(
    "ESP32 + HC-SR04 + MAX30102 + Buzzer"
  );

  Serial.println(
    "Servo: DISABLED"
  );

  Serial.println(
    "================================================"
  );


  // ==========================================================
  // HC-SR04
  // ==========================================================

  pinMode(
    TRIG_PIN,
    OUTPUT
  );

  pinMode(
    ECHO_PIN,
    INPUT
  );


  digitalWrite(
    TRIG_PIN,
    LOW
  );


  // ==========================================================
  // BUZZER
  // ==========================================================

  pinMode(
    BUZZER_PIN,
    OUTPUT
  );

  digitalWrite(
    BUZZER_PIN,
    LOW
  );


  // ==========================================================
  // MAX30102
  // ==========================================================

  setupHeartSensor();


  // ==========================================================
  // HEART RATE TASK
  // ==========================================================

  xTaskCreatePinnedToCore(
    heartRateTask,
    "HeartRateTask",
    8192,
    NULL,
    1,
    NULL,
    tskNO_AFFINITY
  );


  // ==========================================================
  // WIFI
  // ==========================================================

  bool wifiConnected =
    connectWiFi();


  // ==========================================================
  // MQTT TLS
  // ==========================================================

  secureClient.setInsecure();


  mqttClient.setServer(
    MQTT_HOST,
    MQTT_PORT
  );


  mqttClient.setCallback(
    mqttCallback
  );


  // ==========================================================
  // MQTT
  // ==========================================================

  if (
    wifiConnected
  ) {

    connectMqtt();

  }
  else {

    Serial.println(
      "MQTT waiting for Wi-Fi..."
    );
  }


  // ==========================================================
  // SYSTEM READY
  // ==========================================================

  Serial.println();
  Serial.println(
    "================================================"
  );

  Serial.println(
    "SYSTEM READY"
  );

  Serial.println(
    "================================================"
  );

  Serial.println(
    "Distance monitoring : ACTIVE"
  );

  Serial.println(
    "Servo               : DISABLED"
  );

  Serial.println(
    "Heart sensor        : MAX30102"
  );

  Serial.println(
    "Heart session       : 30 seconds"
  );

  Serial.println(
    "Heart interval      : 2 minutes"
  );

  Serial.println(
    "First HR check      : AFTER MQTT CONNECT"
  );

  Serial.println(
    "================================================"
  );
}


// ============================================================
// MAIN LOOP
// ============================================================

void loop() {

  // ==========================================================
  // MQTT MAINTENANCE
  // ==========================================================

  maintainMqtt();


  // ==========================================================
  // WIFI RECONNECT (non-blocking, periodic)
  // ==========================================================

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    heartMonitoringReady =
      false;

    if (
      millis() - lastWifiReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS
    ) {

      lastWifiReconnectAttempt =
        millis();

      Serial.println(
        "Wi-Fi lost — reconnecting..."
      );

      WiFi.disconnect(
        false
      );

      WiFi.begin(
        WIFI_SSID,
        WIFI_PASSWORD
      );
    }

  }
  else {

    // Wi-Fi is up.
    lastWifiReconnectAttempt =
      0;

  }


  // ==========================================================
  // NTP RETRY (non-blocking, periodic; timestamps stay valid)
  // ==========================================================

  if (
    !isTimeSynced() &&
    millis() - lastNtpAttempt >= NTP_RETRY_INTERVAL_MS
  ) {

    lastNtpAttempt =
      millis();

    syncSystemTime();

    Serial.println(
      "NTP not synced yet — retrying..."
    );

  }


  // ==========================================================
  // PENDING ONLINE STATUS (retry once NTP has synced)
  // ==========================================================

  if (
    onlineStatusPending &&
    isTimeSynced() &&
    mqttClient.connected()
  ) {

    publishDeviceStatus(
      "ONLINE",
      "CONNECTED"
    );

  }


  // ==========================================================
  // DISTANCE MEASUREMENT
  // ==========================================================

  currentDistance =
    measureDistance();


  // ==========================================================
  // SERIAL OUTPUT
  // ==========================================================

  Serial.println();
  Serial.println(
    "-----------------------------------------------"
  );


  if (
    currentDistance < 0
  ) {

    Serial.println(
      "Distance : OUT OF RANGE"
    );

  }
  else {

    Serial.print(
      "Distance : "
    );

    Serial.print(
      currentDistance,
      1
    );

    Serial.println(
      " cm"
    );


    // --------------------------------------------------------
    // Distance status
    // --------------------------------------------------------

    if (
      currentDistance <= VERY_CLOSE_MAX_CM
    ) {

      Serial.println(
        "Status   : VERY CLOSE - CONTINUOUS BEEP"
      );

    }
    else if (
      currentDistance < CLOSE_MIN_CM
    ) {

      Serial.println(
        "Status   : CLOSE - FAST BEEP"
      );

    }
    else if (
      currentDistance < WARNING_SILENT_MIN_CM
    ) {

      Serial.println(
        "Status   : MODERATE - SLOW BEEP"
      );

    }
    else {

      Serial.println(
        "Status   : CLEAR"
      );
    }
  }


  // ==========================================================
  // BUZZER
  // ==========================================================

  buzzerControl(
    currentDistance
  );


  // ==========================================================
  // SEND DISTANCE TO MQTT (paced to ~200 ms)
  // ==========================================================

  if (
    millis() - lastRadarPublishMs >= RADAR_PUBLISH_INTERVAL_MS
  ) {

    lastRadarPublishMs =
      millis();

    publishDistanceReading(
      currentDistance
    );
  }


  // ==========================================================
  // SMALL DELAY
  // ==========================================================

  delay(50);
}