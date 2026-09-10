// =====================================================
// BLIND GUARDIAN - MASTER CODE
// ESP32 Smart Assistance System
//
// Components:
// 1. HC-SR04 Ultrasonic Sensor
// 2. SG90 Servo Motor
// 3. Buzzer
// 4. MAX30102 Heart Rate Sensor
// 5. ESP32 Built-in LED
// =====================================================


// =====================================================
// LIBRARIES
// =====================================================

#include <Wire.h>
#include <ESP32Servo.h>
#include "MAX30105.h"
#include "heartRate.h"


// =====================================================
// PIN CONFIGURATION
// =====================================================

// HC-SR04

#define TRIG_PIN 5
#define ECHO_PIN 18


// SG90 Servo

#define SERVO_PIN 13


// Buzzer

#define BUZZER_PIN 19


// MAX30102

#define SDA_PIN 21
#define SCL_PIN 22


// ESP32 Built-in LED

#define LED_PIN 2


// =====================================================
// RADAR SETTINGS
// =====================================================

// Servo scan range

#define MIN_ANGLE 20
#define MAX_ANGLE 160

#define ANGLE_STEP 20


// Obstacle detection distance

#define OBSTACLE_DISTANCE 150


// =====================================================
// OBJECTS
// =====================================================

Servo radarServo;

MAX30105 particleSensor;


// =====================================================
// ULTRASONIC VARIABLES
// =====================================================

long duration;

float distance;


// =====================================================
// RADAR VARIABLES
// =====================================================

int currentAngle = MIN_ANGLE;

int scanDirection = 1;


// =====================================================
// HEART RATE VARIABLES
// =====================================================

const byte RATE_SIZE = 4;

byte rates[RATE_SIZE];

byte rateSpot = 0;

long lastBeat = 0;

float beatsPerMinute = 0;

int beatAvg = 0;


// =====================================================
// FINGER STATUS
// =====================================================

bool fingerDetected = false;


// =====================================================
// TIMING VARIABLES
// =====================================================

unsigned long lastRadarScan = 0;

unsigned long radarInterval = 500;


unsigned long lastBuzzerTime = 0;

bool buzzerState = false;


// LED timing

unsigned long ledOffTime = 0;

bool ledActive = false;


// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);


  Serial.println();
  Serial.println("================================================");
  Serial.println("       BLIND GUARDIAN SYSTEM");
  Serial.println("================================================");


  // -------------------------------------------------
  // HC-SR04 SETUP
  // -------------------------------------------------

  pinMode(TRIG_PIN, OUTPUT);

  pinMode(ECHO_PIN, INPUT);


  // -------------------------------------------------
  // BUZZER SETUP
  // -------------------------------------------------

  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);


  // -------------------------------------------------
  // LED SETUP
  // -------------------------------------------------

  pinMode(LED_PIN, OUTPUT);

  digitalWrite(LED_PIN, LOW);


  // -------------------------------------------------
  // SERVO SETUP
  // -------------------------------------------------

  radarServo.attach(SERVO_PIN);

  radarServo.write(MIN_ANGLE);


  // -------------------------------------------------
  // I2C SETUP
  // -------------------------------------------------

  Wire.begin(SDA_PIN, SCL_PIN);


  // -------------------------------------------------
  // MAX30102 SETUP
  // -------------------------------------------------

  Serial.println();
  Serial.println("Checking MAX30102...");


  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {

    Serial.println("MAX30102 NOT FOUND!");
    Serial.println("Heart monitoring disabled.");

  }
  else {

    Serial.println("MAX30102 CONNECTED SUCCESSFULLY!");


    particleSensor.setup();


    // LED brightness settings

    particleSensor.setPulseAmplitudeRed(0x0A);

    particleSensor.setPulseAmplitudeGreen(0);

  }


  Serial.println();
  Serial.println("SYSTEM READY!");
  Serial.println();

}


// =====================================================
// MEASURE DISTANCE
// =====================================================

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


  // Out of range

  if (duration == 0) {

    return -1;

  }


  // Calculate distance

  float calculatedDistance;

  calculatedDistance = duration * 0.0343 / 2;


  return calculatedDistance;

}


// =====================================================
// GET DIRECTION
// =====================================================

String getDirection(int angle) {


  if (angle >= 20 && angle <= 60) {

    return "LEFT";

  }


  else if (angle >= 61 && angle <= 120) {

    return "CENTER";

  }


  else {

    return "RIGHT";

  }

}


// =====================================================
// GET DISTANCE STATUS
// =====================================================

String getDistanceStatus(float distanceValue) {


  if (distanceValue < 0) {

    return "OUT OF RANGE";

  }


  else if (distanceValue > 150) {

    return "SAFE";

  }


  else if (distanceValue > 100) {

    return "LOW ALERT";

  }


  else if (distanceValue > 50) {

    return "MEDIUM ALERT";

  }


  else {

    return "DANGER";

  }

}


// =====================================================
// BUZZER CONTROL
// =====================================================

void controlBuzzer(float distanceValue) {


  unsigned long currentTime = millis();


  // ----------------------------------------------
  // No valid obstacle
  // ----------------------------------------------

  if (distanceValue < 0 || distanceValue > 150) {

    digitalWrite(BUZZER_PIN, LOW);

    buzzerState = false;

    return;

  }


  // ----------------------------------------------
  // DANGER
  // Below 50 cm
  // ----------------------------------------------

  if (distanceValue <= 50) {

    digitalWrite(BUZZER_PIN, HIGH);

    return;

  }


  // ----------------------------------------------
  // Determine beep interval
  // ----------------------------------------------

  int beepInterval;


  // 50 - 100 cm

  if (distanceValue <= 100) {

    beepInterval = 250;

  }


  // 100 - 150 cm

  else {

    beepInterval = 500;

  }


  // ----------------------------------------------
  // Non-blocking beep
  // ----------------------------------------------

  if (currentTime - lastBuzzerTime >= beepInterval) {


    lastBuzzerTime = currentTime;


    buzzerState = !buzzerState;


    digitalWrite(BUZZER_PIN, buzzerState);

  }

}


// =====================================================
// RADAR SCAN
// =====================================================

void scanRadar() {


  unsigned long currentTime = millis();


  // Check scan timing

  if (currentTime - lastRadarScan < radarInterval) {

    return;

  }


  lastRadarScan = currentTime;


  // ----------------------------------------------
  // MOVE SERVO
  // ----------------------------------------------

  radarServo.write(currentAngle);


  // Small delay for servo movement

  delay(150);


  // ----------------------------------------------
  // MEASURE DISTANCE
  // ----------------------------------------------

  distance = measureDistance();


  // ----------------------------------------------
  // GET DIRECTION
  // ----------------------------------------------

  String direction = getDirection(currentAngle);


  // ----------------------------------------------
  // DISPLAY DATA
  // ----------------------------------------------

  Serial.println();
  Serial.println("----------------------------------------");

  Serial.print("RADAR ANGLE: ");

  Serial.print(currentAngle);

  Serial.println(" degrees");


  Serial.print("DIRECTION: ");

  Serial.println(direction);


  if (distance < 0) {

    Serial.println("DISTANCE: Out of Range");

  }

  else {

    Serial.print("DISTANCE: ");

    Serial.print(distance);

    Serial.println(" cm");


    Serial.print("STATUS: ");

    Serial.println(getDistanceStatus(distance));

  }


  Serial.println("----------------------------------------");


  // ----------------------------------------------
  // BUZZER CONTROL
  // ----------------------------------------------

  controlBuzzer(distance);


  // ----------------------------------------------
  // NEXT ANGLE
  // ----------------------------------------------

  currentAngle += ANGLE_STEP * scanDirection;


  // Change direction at right side

  if (currentAngle >= MAX_ANGLE) {

    currentAngle = MAX_ANGLE;

    scanDirection = -1;

  }


  // Change direction at left side

  if (currentAngle <= MIN_ANGLE) {

    currentAngle = MIN_ANGLE;

    scanDirection = 1;

  }

}


// =====================================================
// HEART RATE MONITOR
// =====================================================

void monitorHeartRate() {


  // Check if sensor exists

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {

    return;

  }


  // Read IR value

  long irValue = particleSensor.getIR();


  // ----------------------------------------------
  // FINGER NOT DETECTED
  // ----------------------------------------------

  if (irValue < 50000) {


    digitalWrite(LED_PIN, LOW);


    if (fingerDetected == true) {

      Serial.println();

      Serial.println("HEART SENSOR: Finger removed");

      fingerDetected = false;

    }


    return;

  }


  // ----------------------------------------------
  // FINGER DETECTED
  // ----------------------------------------------

  if (fingerDetected == false) {

    Serial.println();

    Serial.println("HEART SENSOR: Finger detected");

    fingerDetected = true;

  }


  // ----------------------------------------------
  // HEARTBEAT DETECTION
  // ----------------------------------------------

  if (checkForBeat(irValue)) {


    // --------------------------------------------
    // LED FLASH
    // --------------------------------------------

    digitalWrite(LED_PIN, HIGH);

    ledActive = true;

    ledOffTime = millis();


    // --------------------------------------------
    // BPM CALCULATION
    // --------------------------------------------

    long delta = millis() - lastBeat;


    lastBeat = millis();


    // Ignore first invalid reading

    if (delta > 300 && delta < 3000) {


      beatsPerMinute = 60.0 / (delta / 1000.0);


      // Accept realistic BPM

      if (beatsPerMinute > 30 && beatsPerMinute < 220) {


        // Store BPM

        rates[rateSpot++] = (byte)beatsPerMinute;


        rateSpot %= RATE_SIZE;


        // Calculate average

        beatAvg = 0;


        for (byte i = 0; i < RATE_SIZE; i++) {

          beatAvg += rates[i];

        }


        beatAvg /= RATE_SIZE;


        // ----------------------------------------
        // DISPLAY HEART DATA
        // ----------------------------------------

        Serial.println();

        Serial.println("******** HEARTBEAT DETECTED ********");

        Serial.print("Current BPM: ");

        Serial.println(beatsPerMinute);


        Serial.print("Average BPM: ");

        Serial.println(beatAvg);


        // Heart status

        if (beatAvg > 0 && beatAvg < 60) {

          Serial.println("Heart Status: LOW BPM");

        }

        else if (beatAvg > 100) {

          Serial.println("Heart Status: HIGH BPM");

        }

        else {

          Serial.println("Heart Status: NORMAL");

        }


        Serial.println("************************************");

      }

    }

  }


  // ----------------------------------------------
  // TURN LED OFF AFTER 80ms
  // ----------------------------------------------

  if (ledActive == true) {


    if (millis() - ledOffTime >= 80) {


      digitalWrite(LED_PIN, LOW);

      ledActive = false;

    }

  }

}


// =====================================================
// MAIN LOOP
// =====================================================

void loop() {


  // ----------------------------------------------
  // HEART RATE MONITOR
  // ----------------------------------------------

  monitorHeartRate();


  // ----------------------------------------------
  // SMART RADAR SYSTEM
  // ----------------------------------------------

  scanRadar();


  // ----------------------------------------------
  // SMALL SYSTEM DELAY
  // ----------------------------------------------

  delay(5);

}