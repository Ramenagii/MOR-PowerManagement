/*
  ============================================================================
  MOR / LoadWise — RAW SENSOR TEST SKETCH
  ============================================================================

  Purpose: validate the measurement chain on the bench BEFORE any relay
  control or framework rule is involved. This sketch deliberately contains
  NO relays and NO rules — it only reads the INA226 and the four ZMCT103C
  current channels, and prints them.

  Hardware
    - INA226   @ 0x40 — DC monitor (bus / shunt / current / power)
    - ADS1015  @ 0x48 — 4-channel ADC, one ZMCT103C per mains branch
    - I2C      SDA = GPIO 8, SCL = GPIO 9, 400 kHz
    - CTs      A0..A3 = CH1..CH4

  Why it is shaped this way
    - The sampling task is pinned to core 0 so a 727 ms acquisition pass over
      four channels can never delay serial output on core 1.
    - RMS is single-pass over 600 samples using E[x^2] - mean^2, which removes
      the CT's DC bias without a separate offset window.
    - The filter is adaptive: a change larger than ADAPTIVE_STEP_THRESHOLD snaps
      through immediately, so load steps are not smoothed into staleness.

  Flash (COM10 is the CH343 UART bridge; COM11 native-USB is NOT connected):
    arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device-raw
    arduino-cli upload  -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device-raw
    arduino-cli monitor -p COM10 --config baudrate=115200

  Build with USB CDC On Boot DISABLED: with it enabled Serial is routed to the
  ESP32-S3 native USB port (COM11) and nothing appears on the CH343.

  Libraries: INA226, Adafruit ADS1X15 (+ Adafruit BusIO), ArduinoJson not needed.
  ============================================================================
*/

#include <Wire.h>
#include <INA226.h>
#include <Adafruit_ADS1X15.h>
#include <math.h>

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

// Function Prototypes
void sensorTask(void *pvParameters);
float readChannelRMS(uint8_t channelPin, float calFactor);
float applyPiecewiseCalibration(float rawAmps);
float updateFilteredAmps(float rawAmps, float currentStored);
void printSerialTelemetry();

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
  // BENCH NOTE: 400 kHz FAILS on this wiring - the INA226 stops acknowledging
  // and the sketch halts with "INA226 module not detected at 0x40". The breadboard
  // Dupont runs with 4.7k-10k pull-ups, which cannot meet the 400 kHz rise-time
  // budget. 100 kHz (the ESP32 default) reads both sensors reliably, and the
  // 600-sample acquisition pass has plenty of headroom at that rate.
  // To go back to 400 kHz: shorten the leads to under 10 cm and fit ~2.2k
  // pull-ups, then verify before trusting the readings.
  Wire.setClock(100000);

  Serial.println("\nInitializing Sensors on ESP32-S3...");

  // Bus inventory first. When a sensor goes missing this answers the only
  // question that matters - is ANYTHING on the bus - instead of halting on a
  // single NACK with no diagnosis.
  uint8_t foundDevices = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("i2c: device responding at 0x%02X\n", addr);
      foundDevices++;
    }
  }
  if (foundDevices == 0) {
    Serial.println("i2c: NOTHING responded. Check: sensor VCC (3.3V), common GND,");
    Serial.println("      SDA->GPIO8 / SCL->GPIO9 continuity, and that pull-ups exist.");
  }

  // Initialize INA226 Power Monitor (Rob Tillaart Library)
  if (!ina226.begin()) {
    // Reported, not fatal: the branch CTs are on the other device and are still
    // worth reading. Mains values stay at whatever the last successful read was.
    Serial.println("Error: INA226 module not detected at 0x40! (branch CTs may still work)");
  } else {
    ina226.setMaxCurrentShunt(8.0, 0.010); // Max current first (8.0A), then shunt (10 mOhm)
  }

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