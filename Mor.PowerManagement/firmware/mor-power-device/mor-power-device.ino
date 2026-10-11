/*
  ============================================================================
  MOR / LoadWise — ESP32-S3 power monitoring firmware
  ============================================================================

  Built directly on the validated bench sketch. The measurement engine below is
  the same code that produced the proven readings; this file adds only what the
  dashboard needs on top of it:

    1. Wi-Fi (credentials from config.local.h, git-ignored)
    2. POST /api/Device/telemetry every second
    3. GET  /api/Device/config to pick up P_limit and priorities

  Deliberately NOT in this file, during the sensing phase:
    - relay driving        (RELAY_OUTPUT_ENABLED 0)
    - FR-01..FR-12 rules   (RULES_ENABLED 0)

  Because nothing here trips a protective rule, the shared I2C bus between the
  core-0 ADS1015 task and the core-1 INA226 read cannot cause a fault - a
  garbled transaction would at worst print or report one odd sample.

  Hardware
    INA226  0x40   voltage reference (24 V rail behind a divider) + DC monitoring
    ADS1015 0x48   4-channel ADC, one ZMCT103C per mains branch (CH1-CH4)
    I2C     SDA = GPIO 8, SCL = GPIO 9

  Flash
    arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
    arduino-cli upload  -p COM12 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device

  Build with USB CDC On Boot DISABLED: with it enabled, Serial is routed to the
  ESP32-S3 native USB port instead of the CH343 bridge the board is using.
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <INA226.h>
#include <Adafruit_ADS1X15.h>
#include <math.h>

#include "config.h"

// I2C Pins for ESP32-S3
#define I2C_SDA 8
#define I2C_SCL 9

// I2C Addresses
#define INA226_ADDRESS 0x40
#define ADS1015_ADDRESS 0x48

INA226 ina226(INA226_ADDRESS);
Adafruit_ADS1015 ads;

// Grid Voltage Assumption Variable (Volts AC)
const float AC_VOLTAGE = 238.0;

// Base Sensor Hardware Factors for ZMCT103C
const float CALIBRATION_FACTOR = 0.52;

// Sampling & Filter Parameters
const uint16_t DEDICATED_SAMPLES = 600;       // ~11 AC cycles @ 60Hz (~180ms acquisition per ch)
const float NOISE_FLOOR_AMPS = 0.010;         // 10mA noise gate
const float ADAPTIVE_STEP_THRESHOLD = 0.015;  // 15mA delta triggers instant snapshot

// Cross-Core Shared Sensor Variables
float inaBusVoltage_V = 0.0;
float inaShuntVoltage_mV = 0.0;
float inaCurrent_A = 0.0;
float inaPower_W = 0.0;

float currentAmpsCH1 = 0.0;
float currentAmpsCH2 = 0.0;
float currentAmpsCH3 = 0.0;
float currentAmpsCH4 = 0.0;

float wattageCH1 = 0.0;
float wattageCH2 = 0.0;
float wattageCH3 = 0.0;
float wattageCH4 = 0.0;

// FreeRTOS Handles
SemaphoreHandle_t dataMutex = NULL;
TaskHandle_t sensorTaskHandle = NULL;

// Serial Output Timer (Core 1)
unsigned long lastSerialPrint = 0;
const unsigned long SERIAL_PRINT_INTERVAL_MS = 250; // 4Hz refresh for responsive serial feedback

// Telemetry / config sync (Core 1). Kept separate from the sensor engine so the
// measurement code above stays exactly as validated.
unsigned long lastTelemetryAt = 0;
unsigned long lastConfigAt = 0;
float cfgLimit = 1200.0f;
float cfgWarning = 960.0f;
unsigned long missedPosts = 0;

// Function Prototypes
void sensorTask(void *pvParameters);
float readChannelRMS(uint8_t channelPin, float calFactor);
float applyPiecewiseCalibration(float rawAmps);
float updateFilteredAmps(float rawAmps, float currentStored);
void printSerialTelemetry();
bool postTelemetry();
bool syncConfig();

// =========================================================================
// SETUP (Core 1)
// =========================================================================
void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  // Create Mutex for cross-core memory protection
  dataMutex = xSemaphoreCreateMutex();

  // Initialize Fast-Mode I2C (400 kHz)
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  Serial.println("\nInitializing Sensors on ESP32-S3...");

  // Initialize INA226 Power Monitor (Rob Tillaart Library)
  if (!ina226.begin()) {
    Serial.println("Error: INA226 module not detected at 0x40!");
    while (1) { delay(10); }
  }
  ina226.setMaxCurrentShunt(8.0, 0.010); // Max current first (8.0A), then shunt (10 mOhm)

  // Initialize ADS1015 ADC for ZMCT103C sensors
  if (!ads.begin(ADS1015_ADDRESS, &Wire)) {
    Serial.println("Error: ADS1015 not detected at 0x48!");
    while (1) { delay(100); }
  }
  ads.setGain(GAIN_TWOTHIRDS);
  ads.setDataRate(RATE_ADS1015_3300SPS);

  // Pin High-Speed Sampling Engine to Core 0 (Priority 2)
  xTaskCreatePinnedToCore(
    sensorTask,         /* Task function */
    "SensorEngine",     /* Task name */
    4096,               /* Stack size */
    NULL,               /* Parameters */
    2,                  /* Priority */
    &sensorTaskHandle,  /* Task handle */
    0                   /* Core ID: 0 */
  );

  Serial.println("Initialization Complete. Dual-Core Monitoring Active.\n");

  // Network, then first config sync so P_limit matches the dashboard.
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi ");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" connected, IP: ");
    Serial.println(WiFi.localIP());
    syncConfig();
  } else {
    Serial.println(" failed - running sensors only, no telemetry.");
  }
}

// =========================================================================
// CORE 1: MAIN LOOP (Serial Telemetry & INA226 Polling)
// =========================================================================
void loop() {
  // Read INA226 (DC Monitor) directly on Core 1 using Rob Tillaart functions
  float busV   = ina226.getBusVoltage();       // Returns Bus Voltage in V
  float shuntV = ina226.getShuntVoltage_mV();  // Returns Shunt Voltage in mV
  float inAmps = ina226.getCurrent();          // Returns Current in A
  float inWatts = ina226.getPower();           // Returns Power in W

  // Update INA226 shared variables under mutex
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    inaBusVoltage_V = busV;
    inaShuntVoltage_mV = shuntV;
    inaCurrent_A = inAmps;
    inaPower_W = inWatts;
    xSemaphoreGive(dataMutex);
  }

  // Print Telemetry at 4Hz interval
  if (millis() - lastSerialPrint >= SERIAL_PRINT_INTERVAL_MS) {
    lastSerialPrint = millis();
    printSerialTelemetry();
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (millis() - lastConfigAt > CONFIG_INTERVAL_MS) {
      lastConfigAt = millis();
      syncConfig();
    }
    if (millis() - lastTelemetryAt > TELEMETRY_INTERVAL_MS) {
      lastTelemetryAt = millis();
      postTelemetry();
    }
  }
}

// =========================================================================
// CORE 0: HIGH-SPEED 4-CHANNEL ZMCT103C SAMPLING TASK
// =========================================================================
void sensorTask(void *pvParameters) {
  for (;;) {
    // Read all 4 channels sequentially from ADS1015 (A0, A1, A2, A3)
    float raw1 = applyPiecewiseCalibration(readChannelRMS(0, CALIBRATION_FACTOR));
    float raw2 = applyPiecewiseCalibration(readChannelRMS(1, CALIBRATION_FACTOR));
    float raw3 = applyPiecewiseCalibration(readChannelRMS(2, CALIBRATION_FACTOR));
    float raw4 = applyPiecewiseCalibration(readChannelRMS(3, CALIBRATION_FACTOR));

    // Safely update shared global states under mutex protection
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
      currentAmpsCH1 = updateFilteredAmps(raw1, currentAmpsCH1);
      wattageCH1 = currentAmpsCH1 * AC_VOLTAGE;

      currentAmpsCH2 = updateFilteredAmps(raw2, currentAmpsCH2);
      wattageCH2 = currentAmpsCH2 * AC_VOLTAGE;

      currentAmpsCH3 = updateFilteredAmps(raw3, currentAmpsCH3);
      wattageCH3 = currentAmpsCH3 * AC_VOLTAGE;

      currentAmpsCH4 = updateFilteredAmps(raw4, currentAmpsCH4);
      wattageCH4 = currentAmpsCH4 * AC_VOLTAGE;

      xSemaphoreGive(dataMutex);
    }

    // Yield 1 tick to feed Core 0 watchdog timer
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

// Single-pass RMS computation across dedicated 600 ADC samples
float readChannelRMS(uint8_t channelPin, float calFactor) {
  double sumRaw = 0.0;
  double sumSqRaw = 0.0;

  for (uint16_t i = 0; i < DEDICATED_SAMPLES; i++) {
    int16_t rawADC = ads.readADC_SingleEnded(channelPin);
    sumRaw += rawADC;
    sumSqRaw += (double)rawADC * rawADC;
  }

  double meanRaw = sumRaw / DEDICATED_SAMPLES;
  double variance = (sumSqRaw / DEDICATED_SAMPLES) - (meanRaw * meanRaw);
  if (variance < 0.0) variance = 0.0;

  float rawRMS = sqrt(variance);
  float voltsRMS = rawRMS * ads.computeVolts(1);

  return voltsRMS * calFactor;
}

// Piecewise Calibration: Protects low currents while scaling mid/high range
float applyPiecewiseCalibration(float rawAmps) {
  if (rawAmps < NOISE_FLOOR_AMPS) {
    return 0.0;
  }
  if (rawAmps <= 0.080) {
    return rawAmps; // Pass 1:1 on low range
  }
  const float MID_RANGE_FACTOR = 0.264 / 0.274; // ~0.9635
  return rawAmps * MID_RANGE_FACTOR;
}

// Adaptive EMA Filter: Snaps immediately during load changes, smooths steady state
float updateFilteredAmps(float rawAmps, float currentStored) {
  if (fabs(rawAmps - currentStored) > ADAPTIVE_STEP_THRESHOLD) {
    return rawAmps;
  } else {
    return (currentStored * 0.7) + (rawAmps * 0.3);
  }
}

// Serial Telemetry Output
void printSerialTelemetry() {
  float inaV, inaShunt, inaI, inaP;
  float a1, a2, a3, a4;
  float w1, w2, w3, w4;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    inaV     = inaBusVoltage_V;
    inaShunt = inaShuntVoltage_mV;
    inaI     = inaCurrent_A;
    inaP     = inaPower_W;

    a1 = currentAmpsCH1; w1 = wattageCH1;
    a2 = currentAmpsCH2; w2 = wattageCH2;
    a3 = currentAmpsCH3; w3 = wattageCH3;
    a4 = currentAmpsCH4; w4 = wattageCH4;
    xSemaphoreGive(dataMutex);
  } else {
    return;
  }

  Serial.println("==================================================");
  Serial.print("[INA226 DC] Bus: "); Serial.print(inaV, 3);
  Serial.print(" V | Shunt: "); Serial.print(inaShunt, 3);
  Serial.print(" mV | Current: "); Serial.print(inaI, 3);
  Serial.print(" A | Power: "); Serial.print(inaP, 3); Serial.println(" W");
  Serial.println("--------------------------------------------------");
  Serial.print("[ZMCT103C AC Channels @ "); Serial.print(AC_VOLTAGE, 1); Serial.println("V Grid Voltage]");
  Serial.print("  CH1 (A0) -> "); Serial.print(a1, 3); Serial.print(" A | "); Serial.print(w1, 1); Serial.println(" W");
  Serial.print("  CH2 (A1) -> "); Serial.print(a2, 3); Serial.print(" A | "); Serial.print(w2, 1); Serial.println(" W");
  Serial.print("  CH3 (A2) -> "); Serial.print(a3, 3); Serial.print(" A | "); Serial.print(w3, 1); Serial.println(" W");
  Serial.print("  CH4 (A3) -> "); Serial.print(a4, 3); Serial.print(" A | "); Serial.print(a4 * AC_VOLTAGE, 1); Serial.println(" W");
}

// =========================================================================
// BACKEND TELEMETRY (Core 1)
// =========================================================================
String backendUrl(const char* path) {
  String url = BACKEND_USE_TLS ? "https://" : "http://";
  url += BACKEND_HOST;
  url += ":";
  url += BACKEND_PORT;
  url += BACKEND_BASE;
  url += path;
  return url;
}

// One batch per second. CH1-CH4 carry the measured CT currents; CH5 is the USB
// rail, which has no current sensor, so it is reported at its nominal rating
// rather than being given a fabricated reading.
bool postTelemetry() {
  float a[4], w[4];
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    a[0] = currentAmpsCH1; w[0] = wattageCH1;
    a[1] = currentAmpsCH2; w[1] = wattageCH2;
    a[2] = currentAmpsCH3; w[2] = wattageCH3;
    a[3] = currentAmpsCH4; w[3] = wattageCH4;
    xSemaphoreGive(dataMutex);
  } else {
    return false;
  }

  // Mains volts from the INA226 through the divider; AC_VOLTAGE is the
  // fallback if the sensor is not answering, never a silently zeroed reading.
  float mainsV = inaBusVoltage_V * INA226_MAIN_VOLT_DIVIDER;
  if (!(mainsV > 1.0f)) mainsV = AC_VOLTAGE;

  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["sFault"] = false;                  // no protective rules run yet
  doc["meteringMode"] = 2;                // 2 = Metered (real sensors are read)

  JsonArray readings = doc["readings"].to<JsonArray>();
  for (int i = 0; i < 4; i++) {
    JsonObject r = readings.add<JsonObject>();
    r["outletId"] = i + 1;
    r["voltage"] = mainsV;
    r["currentAmps"] = a[i];
    r["powerWatts"] = w[i];
    r["energyKwh"] = 0.0;                // no cumulative counter on this rig
  }
  // CH5: USB 5 V rail, no CT fitted. Reported as nominal, not measured.
  {
    JsonObject r = readings.add<JsonObject>();
    r["outletId"] = 5;
    r["voltage"] = 5.0;
    r["currentAmps"] = 0.0;
    r["powerWatts"] = 0.0;
    r["energyKwh"] = 0.0;
  }

  JsonArray relays = doc["relayStates"].to<JsonArray>();
  for (int i = 0; i < 5; i++) {
    JsonObject s = relays.add<JsonObject>();
    s["outletId"] = i + 1;
    s["relayClosed"] = true;              // relays are not driven in this phase
  }

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  if (!http.begin(backendUrl("/Device/telemetry"))) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);

  int code = http.POST(payload);
  bool ok = code >= 200 && code < 300;
  if (ok) missedPosts = 0; else missedPosts++;
  http.end();

  if (!ok || missedPosts % 10 == 1) {
    Serial.printf("telemetry: HTTP %d, total=%.0f W\n", code, w[0] + w[1] + w[2] + w[3]);
  }
  return ok;
}

// Picks up P_limit and the warning threshold from the Decision Point so the
// console and the device cannot disagree about the operating limit.
bool syncConfig() {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, backendUrl("/Device/config"))) return false;

  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) return false;

  float limit = doc["criticalThresholdWatts"] | cfgLimit;
  cfgLimit = limit > 0 ? limit : cfgLimit;
  float warn = doc["warningThresholdWatts"] | cfgWarning;
  cfgWarning = warn > 0 ? warn : cfgWarning;

  Serial.printf("config synced: P_limit=%.0f W, %d channels\n",
                cfgLimit, (doc["outlets"].size()));
  return true;
}