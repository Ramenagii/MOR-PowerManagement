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

  config.h is the single source of truth for every calibration and wiring
  constant. Nothing in this file re-declares a value that lives there: if a
  number is bench-adjustable, it belongs in config.h, not here.

  Deliberately NOT in this file, during the sensing phase:
    - FR-01..FR-12 rules   (RULES_ENABLED 0)

  Relays ARE driven (RELAY_OUTPUT_ENABLED 1), but only ever to the level that
  keeps power ON: the bench contacts are NC, so HIGH is the safe state, setup()
  parks every pin HIGH before the sensor task exists, and nothing here commands
  a pin LOW because no rule evaluates yet.

  Because nothing here trips a protective rule, a garbled measurement would at
  worst print or report one odd sample.

  Hardware
    INA226  0x40   3.3V RAIL MONITOR (one job, as of 2026-10-16). It is NOT a
                   mains power meter and its current / power registers are not a
                   mains total (MUST_READ_ Read section 12). Mains is a FIXED
                   238 V constant (MAINS_FIXED_VOLTS in config.h), no longer
                   derived from this sensor, so every CH1-4
                   volt and watt is independent of the INA226 entirely. The raw
                   bus volts + shunt current are what outletId 5 (the USB socket)
                   posts as its volts and amps, and the same four figures go out
                   in doc["ina"]. The bus pin is EXPECTED TO READ ~3.3 V now: ~5 V
                   means the module is on the USB rail, and ~24 V means it is
                   physically still on the 24 V rail and must be rewired - do not
                   fudge a constant to hide either.
    ADS1220 SPI   24-bit ADC, one ZMCT103C per mains branch (CH1-CH4).
                   CS = GPIO 10, DRDY = GPIO 14, SCLK = 12, MISO = 13,
                   MOSI = 11. Single-ended against AVSS, AVDD as VREF.
    I2C     SDA = GPIO 8, SCL = GPIO 9  (I2C_SDA_PIN / I2C_SCL_PIN), INA226
            only. The CT channels are on SPI, so the two sensors no longer
            share a bus.
    RELAY   CH1 = GPIO 1, CH2 = GPIO 2, CH3 = GPIO 4, CH4 = GPIO 5 (RELAY_PINS).
             Operator wiring, corrected 2026-10-16 (was CH1 = GPIO 2, CH2 = GPIO 1).
            CH5 = the USB socket: NO RELAY, monitored only - nothing drives it.

  Channels
    CH1-CH4  220 V mains outlets, CT-metered (BRANCH_CT_COUNT = 4). Watts are
             amps x the single mains voltage from the FIXED 238 V constant,
             exactly as before.
    CH5      USB socket, outletId 5. No CT and no relay. Volts = INA226 bus V,
             amps = INA226 shunt A, watts = their product. It is a real
             measurement of a real rail, not a fabricated zero and not a
             residual - see the residual warning below.

  Tiers (must match the backend seed; RULES_ENABLED is 0 so nothing acts yet)
    CH1 Critical | CH2 Important | CH3 Deferrable | CH4 Nonessential
    CH5 USB - Low / priority-only

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
#include <SPI.h>
#include <ADS1220_WE.h>
#include <math.h>

#include "config.h"

INA226 ina226(INA226_ADDR);

// The ADS1220 is the ONLY user of SPI on this board. The pins are given
// explicitly because they are not the ESP32-S3 VSPI defaults (10/12/11/13 would
// be the default set; DRDY on 14 is what the library polls between conversions).
// pc = true is the flag that tells the library "SPI has been remapped, call
// begin(sclk, miso, mosi, cs)"; init() below is what actually performs it.
ADS1220_WE ads1220(&SPI, ADS1220_CS_PIN, ADS1220_DRDY_PIN,
                   ADS1220_MOSI_PIN, ADS1220_MISO_PIN, ADS1220_SCLK_PIN, true);

// MUX per CT channel. Single-ended against AVSS: the ZMCT103C output is a
// 2.5 V-biased AC ripple referenced to ground, with no negative excursion to
// pair it with, so AINx/AVSS is the correct comparison (not AINx/AIN0).
//
// Sized for 4 (the ADS1220's full single-ended input count) and NOW FULLY
// POPULATED: the 4-CT rig is live, so every slot below is a real input and the
// ADS1220_MUX_UNUSED sentinel is gone. The sentinel existed so that raising
// BRANCH_CT_COUNT without filling the table would read the internal reference
// and collapse the mV RMS to ~0 - an obviously broken chain rather than two
// channels silently reporting the same AIN1. That protection is now provided by
// the static_assert below, which fails at COMPILE time instead: if a slot were
// ever left unfilled or BRANCH_CT_COUNT were raised above the fitted CTs, the
// build stops instead of posting a fabricated reading.
//
// Channel mapping: CH1 -> AIN0, CH2 -> AIN1, CH3 -> AIN2, CH4 -> AIN3.
static const ads1220Mux CT_MUX[4] = {
  ADS1220_MUX_0_AVSS,   // CH1 -> AIN0 (fitted, active)
  ADS1220_MUX_1_AVSS,   // CH2 -> AIN1 (fitted, active)
  ADS1220_MUX_2_AVSS,   // CH3 -> AIN2 (fitted, active)
  ADS1220_MUX_3_AVSS,   // CH4 -> AIN3 (fitted, active)
};
static_assert(BRANCH_CT_COUNT <= 4, "ADS1220 has 4 single-ended inputs");

// Measured cost of ONE blocking single-shot conversion, in microseconds, timed
// by the boot self-test in setup() and handed to the sweep. It exists so the
// sweep can bound its own duration: the task is pinned to core 0 with no yield
// inside a channel window, so a sweep that overruns its period leaves IDLE0 no
// scheduler slot at all and the task watchdog reboots the rig. Measured, not
// assumed, because the real cost depends on the data rate actually in force.
uint32_t gSampleCostUs = 500;   // replaced by the self-test before setup() ends

// One CT channel's raw measurement window, in the three forms the bench needs.
// The intermediate forms are kept (rather than collapsing straight to amps) so
// the calibration mode can show the operator exactly where the scaling goes
// wrong: the count RMS says whether the signal reaches the ADC at all, the mV
// RMS is the quantity ZMCT_CAL_FACTOR is defined against, and amps is what the
// CURRENT factor claims the branch is drawing.
struct ZmctReading {
  float countsRms;      // ADS1220 code RMS, raw, DC-removed (NOT volts)
  float millivoltsRms;  // the same window in mV at the running reference + gain
  float amps;           // millivoltsRms / 1000 x ZMCT_CAL_FACTOR (A per V)
};

// The USB outlet (outletId 5) is MONITORED, not fabricated.
//
// It has no CT - the ADS1220's four inputs are all taken by CH1-CH4 - and it
// used to have no sensor at all, which is why the 2-channel rig posted nothing
// rather than posting a zero. It is not in that position any more: the INA226
// measures the rail the socket is on, so outletId 5 posts the sensor's OWN
// volts and amps. That is a real measurement, not a placeholder.
//
// Deliberately NOT a residual (mains total minus the measured branches): the
// INA226 is not on the mains feed, so there is no mains total here to subtract
// from, and a fabricated residual would be a lie in the telemetry. The volts
// posted are the RAW INA226 bus-pin reading, NOT mainsV and NOT busV x any
// divider - the INA226 is the 3.3V rail monitor now (bus expected ~3.3 V) and the
// mains figure it used to be multiplied into is a fixed constant.
#define USB_OUTLET_ID (BRANCH_CT_COUNT + 1)      // 5
// The USB socket must be the LAST outlet, because isMonitoredOnly() and every
// index calculation below key off OUTLET_COUNT - 1. If that ever stops being
// true the firmware would skip a real relay and report the socket as cut, so
// the build stops instead.
static_assert(USB_OUTLET_ID == OUTLET_COUNT,
              "the monitored-only USB outlet must be the last outletId");
// Watts for the USB outlet: the product of the two INA226 figures, taken from
// the SAME dataMutex hold as the volts and amps they were read with, so
// powerWatts == currentAmps * voltage holds exactly here as it does on CH1-CH4.
static inline float usbWatts(float busV, float amps) { return busV * amps; }

// Relay DESIRED state, one entry per outlet: true = contact closed = power ON.
// This is the single source the telemetry reports from AND the state the pins
// are driven to, so the dashboard can never claim a state the hardware is not
// in. Nothing actuates it yet (RULES_ENABLED 0, no switch inputs fitted), so it
// boots all-true and only a future FR rule or a wired manual switch will clear
// a bit. NC contacts: closed == HIGH == RELAY_POWER_ON_LEVEL.
//
// The USB entry is forced true and is NOT driven to a pin (USB_OUTLET_NO_RELAY):
// there is no relay behind the socket, so it can only ever report CLOSED.
bool relayClosedDesired[OUTLET_COUNT] = { true, true, true, true, true };

// The outlet status ORDINAL the backend last sent for each channel, and a
// counter used to throttle the "config synced" line (config sync runs at
// CONFIG_INTERVAL_MS, which is fast enough to flood the console). Purely
// diagnostic - nothing acts on these, they exist so a mismatch between the
// backend's view and the device's view is visible on the bench.
int8_t lastDesiredStatus[OUTLET_COUNT] = { -1, -1, -1, -1, -1 };
uint32_t syncCount = 0;

// True for the one outlet that is monitored only and has no relay behind it.
// The index arithmetic (OUTLET_COUNT - 1) assumes the USB socket is the LAST
// channel; config.h static_asserts that assumption cannot be violated silently.
static inline bool isMonitoredOnly(uint8_t idx) {
#if USB_OUTLET_NO_RELAY
  return idx == (OUTLET_COUNT - 1);
#else
  (void)idx;
  return false;
#endif
}

// Drives every relay pin to its desired state. Called at boot, after every
// config sync, and before each telemetry batch, so the state the backend is
// told about is the state the hardware is in when the batch is serialised (not
// merely intended). RELAY_OUTPUT_ENABLED gates only the pin write: the desired
// state is still tracked and still reported when it is 0, so the dashboard
// never sees a silent device claim a relay state it is not enforcing.
//
// RELAY-STATE VERSION STAMP (2026-10-16, step-spike suppression)
//
// An RMS window that spans a relay open/close contains samples from TWO steady
// states. Mean-subtracted variance across a step is dominated by the step, not
// by the AC ripple, so such a window reports an RMS far above anything the branch
// can actually draw: observed live as 792 W / 3.33 A on CH1, whose whole peak
// history was 127 W. That phantom reading then lands on the dashboard as a real
// power spike, and the adaptive EMA snaps to it (a step larger than
// ZMCT_ADAPTIVE_STEP_AMPS passes through untouched), so one transition
// contaminates the next several sweeps as well.
//
// Fix, and it is deliberately the SMALLEST one that works: a window is only
// valid if no relay pin moved while it was being collected. relayStateVersion
// below is the stamp that says whether that was true; sensorTask() compares the
// stamp from before a channel window with the stamp after it and DISCARDS the
// window if it moved. Nothing is latched, no sweep is delayed, and the next
// window after the transition is published normally - one clean window per
// transition is all the physics needs.
//
// The counter is written by core 1 (applyRelays, from loop()/syncConfig/
// postTelemetry) and read by core 0 (sensorTask). It is a single 32-bit word, so
// every read and write of it is atomic on this core and no mutex is needed for
// the stamp itself; a torn value is impossible, and a value that changed
// between the two reads is exactly the condition being detected.
volatile uint32_t relayStateVersion = 0;
// Last level actually driven to each pin, -1 until the first applyRelays().
// Without this the boot-time write (setup() parks the pins HIGH, then calls
// applyRelays()) would be indistinguishable from a real transition and would
// stamp the version once for nothing.
int8_t relayAppliedLevel[OUTLET_COUNT] = { -1, -1, -1, -1, -1 };

// The monitored-only channel (the USB socket) is SKIPPED: RELAY_PINS[idx] there
// is a reserved placeholder, not a wired relay, and driving it would switch a
// pin that goes nowhere while the dashboard implied the socket had been cut.
void applyRelays() {
#if RELAY_OUTPUT_ENABLED
  bool changed = false;
  for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
    if (isMonitoredOnly(i)) continue;
    const int8_t target = relayClosedDesired[i] ? (int8_t)RELAY_POWER_ON_LEVEL
                                                : (int8_t)RELAY_POWER_OFF_LEVEL;
    // The level actually on the pin BEFORE the write, so the stamp tracks a
    // real transition rather than an intention. A pin that is already where it
    // is being asked to go does not stamp the version - re-writing the same
    // level is not a transition and must not cost a CT window.
    const int8_t before = (int8_t)digitalRead(RELAY_PINS[i]);
    digitalWrite(RELAY_PINS[i], target);
    if (relayAppliedLevel[i] < 0 || before != target) {
      relayAppliedLevel[i] = target;
      changed = true;
    }
  }
  // One bump per applyRelays() pass, whatever the number of pins that moved: the
  // stamp is a "did anything move while you were sampling" flag, not a count of
  // pins, and a pass that moved nothing must leave it untouched.
  if (changed) relayStateVersion++;
#endif
  // A monitored-only outlet can never be open. Forcing the bit here rather than
  // only at post time means every reader of relayClosedDesired[] - serial, sync,
  // telemetry - sees the same thing, so there is no path that can report the
  // socket as cut.
  for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
    if (isMonitoredOnly(i)) relayClosedDesired[i] = true;
  }
}

// Cross-core Shared Sensor Variables
// Written by loop() (core 1) or sensorTask (core 0), read by the other core.
// EVERY access to these is inside a dataMutex critical section.
float inaBusVoltage_V = 0.0;
// The ONE mains voltage the whole firmware reports against.
//
// PROVENANCE CHANGED 2026-10-16 (operator direction): it is now the FIXED
// MAINS_FIXED_VOLTS constant (238 V, adopted from the operator's reference
// sketch - see the provenance conflict documented on the constant in config.h;
// it was 228 V from a multimeter until that same pass), NOT the INA226
// bus-pin volts x INA226_MAIN_VOLT_DIVIDER. The divider path is gone; the
// constant that recorded how 228 V was originally derived is kept unused in
// config.h as history.
//
// It is initialised from MAINS_FIXED_VOLTS and is no longer recomputed from any
// sensor, so no sensor fault and no rewire can move it. FALLBACK_MAINS_VOLTS
// happens to be the same 238.0 today, which is deliberate: a degraded rig
// reports the same mains as a healthy one. Both the posted branch volts and
// every branch watt are derived from this single value, so the two can never
// contradict each other on the dashboard (they used to: 228 V posted next to
// 238 V-derived watts).
float mainsVolts_V = MAINS_FIXED_VOLTS;
float inaShuntVoltage_mV = 0.0;
float inaCurrent_A = 0.0;
float inaPower_W = 0.0;

// Sensor presence, resolved once in setup() and then read-only. setup() runs on
// Core 1 before the Core-0 sampling task exists, so no lock is needed to read
// these from either core.
// Ported from master 2a8f022 ("Make a missing sensor non-fatal"): detection
// DEGRADES instead of halting. The old code spun in while(1) on a detection
// failure, so one unplugged module meant no Wi-Fi, no telemetry and a
// permanently empty dashboard with nothing on screen to explain why.
//   INA226 missing  -> outlet 5 reports 0 V / 0 A from that sensor; mains volts
//                      are unaffected because they are a FIXED constant now, and
//                      FALLBACK_MAINS_VOLTS is the same 238 V it would report
//   ADS1220 missing -> branch amps stay 0.00 A and the Core-0 sweep is not
//                      started (an unACKed SPI device would stall the task rather
//                      than return a clean zero)
// Either way the device still connects, still posts, and reports the fault.
bool ina226Present = false;
bool ads1220Present = false;

// Per-branch CT current, index 0 = CH1 (ADS1220 AIN0/AVSS) .. index 3 = CH4
// (AIN3/AVSS). The USB socket (outletId 5) is NOT in this array: it has no CT
// and its current is the INA226's, posted separately from inaCurrent_A.
// Watts are deliberately NOT stored per branch: storing them beside the amps
// they came from is what let the firmware publish a voltage and a wattage
// derived from two different mains readings. They are computed from amps and
// mainsVolts_V at the point of use instead (see branchWatts).
float branchAmps[BRANCH_CT_COUNT] = {0.0f};

// Last raw sweep per channel, so the calibration mode can print the un-
// calibrated chain without disturbing sampling. Same mutex as everything else.
ZmctReading branchRaw[BRANCH_CT_COUNT];

// TRUE for a channel whose last raw window straddled a relay transition and was
// therefore discarded (see relayStateVersion). branchAmps[] for that channel is
// left at its PREVIOUS value on purpose: the amps a CT reports while the branch
// is switching between two loads is a real measurement of neither, and the step
// in it is what posts the phantom spike. Holding the last good reading for one
// sweep is a stale-but-true number; publishing the contaminated one is a wrong
// one. Read under dataMutex alongside branchRaw[].
bool branchRawStale[BRANCH_CT_COUNT] = { false, false, false, false };

// FreeRTOS Handles
SemaphoreHandle_t dataMutex = NULL;
TaskHandle_t sensorTaskHandle = NULL;

// I2C BUS mutex - a DIFFERENT lock from dataMutex, and the absence of it is the
// single most damaging bug this firmware ever shipped. It is kept even though
// the CT sweep no longer needs it: the CT ADC moved from the shared I2C bus
// (ADS1015) to SPI (ADS1220), so the INA226 poll is now the only bus user on
// core 1. The lock is still what guarantees that any Wire code added later
// cannot re-introduce the interleaved-transfer failure, and the failure it
// describes is worth keeping in the file precisely because it looked like
// something else.
//
// dataMutex protects the shared VARIABLES. It does nothing for the bus itself.
// Before the ADC moved to SPI, the ADS1015 sweep on core 0 and the INA226 poll
// on core 1 issued interleaved transactions on one shared Wire bus with nothing
// serialising them, so each core could begin a transfer while the other was
// mid-transaction. Observed failure on the bench: both devices ACK at boot, then
// the instant the sweep starts the INA226 reads 0.000 V and every CT channel
// reads exactly 0.000 A forever - the rig keeps posting telemetry, so the
// dashboard shows a healthy online device reporting a confident 0 W on every
// channel, which is indistinguishable from "no load connected". That is how this
// presented as "the bus went silent" and was mistaken for a wiring fault.
//
// Every function that touches Wire must hold this lock. Today that is the
// INA226 poll in loop() and nothing else; do not delete the lock on the grounds
// that "only one core uses the bus now".
SemaphoreHandle_t i2cMutex = NULL;

// SPI BUS mutex - same reasoning, same "do not delete" rule, for the ADS1220.
// The CT sweep on core 0 is the only SPI user today, but it holds the chip
// select low across a conversion window and any future core-1 register access
// (calibration pre-flight, IDAC routing, a temperature read) would interleave
// with it in exactly the same way the I2C transactions used to.
SemaphoreHandle_t spiMutex = NULL;

// Serial Output Timer (Core 1)
unsigned long lastSerialPrint = 0;
const unsigned long SERIAL_PRINT_INTERVAL_MS = 250; // 4 Hz refresh for responsive serial feedback

// Telemetry / config sync (Core 1). Kept separate from the sensor engine so the
// measurement code above stays exactly as validated.
unsigned long lastTelemetryAt = 0;
unsigned long lastConfigAt = 0;
float cfgLimit = 1200.0f;
float cfgWarning = 960.0f;
unsigned long missedPosts = 0;

// Function Prototypes
void sensorTask(void *pvParameters);
ZmctReading readChannel(uint8_t channel);
float applyPiecewiseCalibration(float rawAmps);
float updateFilteredAmps(float rawAmps, float currentStored);
float branchWatts(float amps, float mainsVolts);
void applyRelays();
void printSerialTelemetry();
bool postTelemetry();
bool syncConfig();

// The ADS1015 config-register pre-flight (adsReadConfigRegister +
// printCalibrationPreflight) was removed with the part: it existed to decode
// ADS1X15 register bits over I2C before trusting an amps figure, and the
// ADS1220 is configured and verified on SPI instead. Its purpose is preserved
// by the ZMCT_CALIBRATION_MODE chain in printSerialTelemetry(), which prints the
// un-calibrated counts/mV/amps per channel so a wrong reference or PGA shows up
// as a number rather than as a silently-scaled current.

// =========================================================================
// SETUP (Core 1)
// =========================================================================
void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  // Create Mutex for cross-core memory protection
  dataMutex = xSemaphoreCreateMutex();
  // Separate lock for each BUS. Created before anything touches Wire or SPI, so
  // no code path can reach a bus unguarded.
  i2cMutex = xSemaphoreCreateMutex();
  spiMutex = xSemaphoreCreateMutex();

  // I2C bus. Pin pair AND speed come from config.h. The speed is 100 kHz
  // because a 400 kHz build found NEITHER I2C device on this wiring while
  // 100 kHz found both - overriding it here would make both sensors vanish.
  // Only the INA226 is on this bus now; the CT ADC is on SPI.
  //
  // NOT PORTED from master 2a8f022, which forced 400 kHz on a different rig and
  // wiring (INA226 + ADS1015 sharing the bus). That bus scan does not describe
  // this one, where the CT ADC left I2C entirely for SPI, so config.h's validated
  // 100 kHz stands.
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);

  Serial.println("\nInitializing Sensors on ESP32-S3...");

  // A missing sensor must NEVER hang the device. Detection degrades instead of
  // halting: outlet 5's USB reading falls back to zero, and every batch is
  // posted with the fault flag raised, so the console labels the readings as
  // degraded instead of presenting them as verified. Mains volts are unaffected
  // either way - they are a FIXED 238 V constant, not a sensor reading.
  ina226Present = ina226.begin();
  if (ina226Present) {
    // Max current first, then shunt: 2 A full scale on a 100 mOhm shunt, which
    // is the part physically fitted on this board (see INA226_SHUNT_OHM). The
    // previous 8 A / 10 mOhm pairing assumed a mains-side shunt that is not
    // here, and because current is derived from shunt volts it reported every
    // DC reading 10x HIGH. Wrong values scale every current and watt reading
    // on this sensor, so they are stated at boot rather than left implicit.
    ina226.setMaxCurrentShunt(INA226_MAX_CURRENT_AMPS, INA226_SHUNT_OHM);
    Serial.print("INA226  OK  (0x");
    Serial.print(INA226_ADDR, HEX);
    Serial.print(") - outletId ");
    Serial.print(USB_OUTLET_ID);
    Serial.print(" 3.3V rail monitor, ");
    Serial.print(INA226_MAX_CURRENT_AMPS, 1);
    Serial.print("A/");
    Serial.print(INA226_SHUNT_OHM, 3);
    Serial.print("Ohm shunt, bus expected ~3.3 V (raw busV/shuntA). ");
    Serial.print("Mains is FIXED at ");
    Serial.print(MAINS_FIXED_VOLTS, 1);
    Serial.println(" V (no divider in the voltage path).");
  } else {
    Serial.print("Error: INA226 module not detected at 0x");
    Serial.println(INA226_ADDR, HEX);
    Serial.println("INA226  MISSING - outlet 5 USB reading falls back to zero "
                   "(mains is a FIXED constant and is unaffected); readings will be "
                   "flagged. Continuing: telemetry must not go dark.");
  }

  // ---- Relay outputs ----
  // Park every relay pin in its SAFE state BEFORE the sensor task exists and
  // before anything can be posted. The contacts are NC, so RELAY_POWER_ON_LEVEL
  // (HIGH) is the safe level: power passes while the coil is idle. The pinMode
  // is written before the level precisely so the pin is an output when it is
  // driven HIGH - a pin left as a floating input would let the coil state be
  // undefined, and undefined is not an acceptable state for 220 V.
  //
  // The monitored-only channel (the USB socket) is skipped entirely: its
  // RELAY_PINS entry is a reserved placeholder with no relay behind it, and
  // pinMode-ing it would make a spare GPIO an output driven high for no reason.
  for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
    if (isMonitoredOnly(i)) continue;
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], RELAY_POWER_ON_LEVEL);
  }
  // Then enforce the desired state (all-true on this rig) from one place, so
  // boot and steady state cannot disagree.
  applyRelays();

  // ---- Relay GPIO table, printed once at boot ----
  // The single place the wiring is visible on the bench. The pin numbers come
  // from the ESP32-S3 exclusion banks (not strapping, not USB-JTAG 19/20, not
  // I2C 8/9, not SPI 10-14, not in the octal-PSRAM pin set) AND from the
  // operator's measured wiring. The CH1/CH2 order was wrong until 2026-10-16
  // ({2,1} -> {1,2}); if an outlet's CT does not drop to zero on its own
  // disconnect, THIS line is what gets corrected - change RELAY_PINS here in
  // config.h and the RELAY_PIN_n aliases with it, then reflash.
  Serial.print("[RELAY] pins:");
  for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
    Serial.print(" CH"); Serial.print(i + 1); Serial.print("=GPIO");
    Serial.print(RELAY_PINS[i]);
    if (isMonitoredOnly(i)) Serial.print("(MONITORED-ONLY,no relay)");
  }
  Serial.println();
  Serial.print("[RELAY] tiers: CH1 Critical | CH2 Important | CH3 Deferrable | "
               "CH4 Nonessential | CH5 USB Low/priority-only");
  Serial.println();
  Serial.println("[RELAY] an outlet is only PROVEN when its OWN CT current goes to");
  Serial.println("[RELAY]   0.000 A on its disconnect and returns on reconnect.");

  // ---- ADS1220: 24-bit SPI ADC for the ZMCT103C CT sensors ----
  // init() brings up SPI on the remapped pins, resets the ADC and verifies it
  // answers by reading a configuration register back; false means the ADC is
  // not there. Non-fatal (master 2a8f022, ported): the Core-0 sweep is simply
  // never started, branchAmps[] keeps its zero initialisers, and every batch is
  // posted with the fault flag raised. Hanging instead would post NOTHING, which
  // is indistinguishable on the dashboard from a dead device.
  ads1220Present = ads1220.init();
  if (!ads1220Present) {
    Serial.println("Error: ADS1220 not detected (SPI CS=");
    Serial.print(ADS1220_CS_PIN);
    Serial.println(")");
    Serial.println("ADS1220 MISSING - branch current will read 0.00 A and readings "
                   "will be flagged. Continuing: telemetry must not go dark.");
  } else {
    ads1220.setSPIClockSpeed(ADS1220_SPI_CLOCK_HZ);
    // AVDD as VREF, calibrated by the ADC's own internal measurement. The CT
    // modules are biased at 2.5 V, which the internal 2.048 V reference would
    // clip - see the ADS1220 block in config.h.
    if (ADS1220_USE_AVDD_AS_VREF) {
      ads1220.setAvddAvssAsVrefAndCalibrate();
    } else {
      ads1220.setIntVRef();
    }
    ads1220.setGain(ADS_PGA_GAIN);
    ads1220.setOperatingMode(ADS_OP_MODE);
    ads1220.setDataRate(ADS_DATA_RATE);
    ads1220.setConversionMode(ADS1220_SINGLE_SHOT);
    // Configured BEFORE the sensor task is created, so no conversion can be in
    // flight while the MUX is being set. readChannel() also switches MUX per
    // channel; this first switch both primes the gain bookkeeping and gives the
    // task a known starting point.
    ads1220.setCompareChannels(CT_MUX[0]);

    // ---- ADC self-test: is it ACTUALLY converting, and how fast? ----
    // This is the ADS1220's replacement for the deleted ADS1015 register
    // pre-flight, and it checks the thing a register decode could not: whether a
    // conversion ever completes. One blocking single-shot read, timed, plus the
    // DRDY level before and after. It runs here, on core 1, BEFORE the sensor task
    // exists, so a slow or stuck ADC is reported instead of silently turning the
    // sweep into a multi-second CPU hog that starves IDLE0 and trips the task
    // watchdog (a live rig reboot loop caused exactly that - see below).
    Serial.print("[ADC] self-test: DRDY(GPIO"); Serial.print(ADS1220_DRDY_PIN);
    Serial.print(") before="); Serial.print(digitalRead(ADS1220_DRDY_PIN) ? "HIGH" : "LOW");
    uint32_t t0 = micros();
    const int32_t probeCode = ads1220.getRawData();
    const uint32_t t1 = micros();
    Serial.print(" | 1 conversion="); Serial.print((uint32_t)(t1 - t0));
    Serial.print(" us | code="); Serial.print(probeCode);
    Serial.print(" | DRDY after="); Serial.println(digitalRead(ADS1220_DRDY_PIN) ? "HIGH" : "LOW");
    if (t1 - t0 > 5000) {
      Serial.println("[ADC] WARNING: one conversion took > 5 ms, so ADS_DATA_RATE is not");
      Serial.println("[ADC]   in force (2000 SPS = ~500 us) OR DRDY is not wired/asserted.");
      Serial.println("[ADC]   A 600-sample sweep would overrun METER_INTERVAL_MS and trip the");
      Serial.println("[ADC]   task watchdog. Fix the ADC config or the DRDY wiring first.");
    }
    // Per-sample cost at the configured rate, used to bound the sweep budget below.
    const uint32_t probeUs = (t1 > t0) ? (uint32_t)(t1 - t0) : 500;

    Serial.print("[ADC] ADS1220 ready: CS="); Serial.print(ADS1220_CS_PIN);
    Serial.print(" DRDY="); Serial.print(ADS1220_DRDY_PIN);
    Serial.print(" SCLK="); Serial.print(ADS1220_SCLK_PIN);
    Serial.print(" MISO="); Serial.print(ADS1220_MISO_PIN);
    Serial.print(" MOSI="); Serial.print(ADS1220_MOSI_PIN);
    Serial.println();
    Serial.print("[ADC] VREF="); Serial.print(ads1220.getVRef_V(), 3);
    Serial.print(" V (AVDD-calibrated) | single-shot | window=");
    Serial.print(ZMCT_DEDICATED_SAMPLES);
    Serial.print(" samples/channel | opmode+DR=ADS_OP_MODE/ADS_DATA_RATE (turbo, 2000 SPS)");
    Serial.print(" | CT channels="); Serial.print(BRANCH_CT_COUNT);
    Serial.print(" (AIN0..AIN"); Serial.print(BRANCH_CT_COUNT - 1);
    Serial.print(") | outlets="); Serial.print(OUTLET_COUNT);
    Serial.print(" (CH1-4 CT + CH"); Serial.print(USB_OUTLET_ID);
    Serial.print(" USB on INA226) | sweep="); Serial.print(METER_INTERVAL_MS / 1000);
    Serial.println(" s");

    // Hand the measured per-conversion cost to the sweep so it can bound itself
    // instead of running flat out into the watchdog. See sensorTask().
    gSampleCostUs = probeUs;
  }

  // Pin High-Speed Sampling Engine to Core 0. Only when the ADC is actually
  // present: with nothing on SPI to ACK, the sweep would burn a core spinning
  // on reads that can never complete, starving IDLE0 and the task watchdog.
  if (ads1220Present) {
    xTaskCreatePinnedToCore(
      sensorTask,                 /* Task function */
      "SensorEngine",             /* Task name */
      SENSOR_TASK_STACK,          /* Stack size (config.h) */
      NULL,                       /* Parameters */
      SENSOR_TASK_PRIORITY,       /* Priority (config.h) */
      &sensorTaskHandle,          /* Task handle */
      0                           /* Core ID: 0 */
    );
  }

  Serial.println("Initialization Complete. Dual-Core Monitoring Active.\n");

  if (ZMCT_CALIBRATION_MODE) {
    Serial.println("[CAL MODE ON] printing the un-calibrated CT chain per channel.");
    if (ZMCT_CAL_REF_WATTS > 0.0f) {
      Serial.print("[CAL MODE ON] reference load = ");
      Serial.print(ZMCT_CAL_REF_WATTS, 1);
      Serial.println(" W - suggested factors follow. PRINT ONLY, no behaviour changed.");
    } else {
      Serial.println("[CAL MODE ON] no reference wattage set (ZMCT_CAL_REF_WATTS = 0), "
                     "so no suggested factor is printed. PRINT ONLY, no behaviour changed.");
    }
  }

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

unsigned long lastInaPoll = 0;

// =========================================================================
// CORE 1: MAIN LOOP (Serial Telemetry & INA226 Polling)
// =========================================================================
void loop() {
  // Read the INA226 (3.3V rail monitor) on Core 1, on a fixed
  // interval rather than on every pass. loop() executes thousands of times per
  // second; an unguarded poll on each pass contends with the core-0 sweep for
  // the shared I2C bus and starves it. It measures one DC rail, so a 4 Hz
  // sample is far more than the rail needs.
  // Skipped entirely when the module was not detected in setup(): calling the
  // getters against an absent device would put a guaranteed-NACK transaction on
  // the I2C bus every pass, which is worse than reading nothing. mainsVolts_V
  // is a FIXED 238 V constant and is NOT affected either way; every batch is
  // posted with the fault raised.
  if (ina226Present && millis() - lastInaPoll >= INA226_POLL_INTERVAL_MS) {
    lastInaPoll = millis();

    float busV = 0.0, shuntV = 0.0, inAmps = 0.0, inWatts = 0.0;
    bool readOk = false;
    // Bus lock FIRST, then the variable lock: never the reverse, so the bus is
    // never held while waiting on dataMutex.
    if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      busV   = ina226.getBusVoltage();       // V at the INA226 bus pin (~3.3 V expected)
      // Shunt 0.1 Ohm / 2 A full scale - the part actually fitted, not the
      // 10 mOhm mains-side shunt these getters used to be annotated with. The
      // annotation mattered: it is the scale every current and watt figure on
      // this sensor is multiplied by, and it was 10x the real part.
      shuntV = ina226.getShuntVoltage_mV();  // mV across the 0.1 Ohm shunt
      inAmps = ina226.getCurrent();          // A through the 0.1 Ohm shunt
      inWatts = ina226.getPower();           // W at the INA226 bus pin
      readOk = true;
      xSemaphoreGive(i2cMutex);
    }

    if (readOk) {
      // NO mains derivation here any more. This block used to compute
      // mainsV = busV * INA226_MAIN_VOLT_DIVIDER (x 9.46) and store it into
      // mainsVolts_V. Per operator direction 2026-10-16 mains is a FIXED
      // 238 V constant (MAINS_FIXED_VOLTS, frozen into config.h - originally a
      // bench multimeter reading, now the reference sketch's value), and the
      // INA226 is only the 3.3V rail monitor - so
      // there is nothing to compute from busV, and multiplying a 3.3 V rail
      // reading by 9.46 would post 31 V for outlet 5.
      //
      // mainsVolts_V is therefore NOT written from this block at all. It is set
      // once at its declaration and left there, which also means a sensor fault
      // can no longer move the voltage every CH1-4 watt is multiplied by.
      // The guard that used to fall back to FALLBACK_MAINS_VOLTS on a dead
      // sensor has no counterpart here - FALLBACK_MAINS_VOLTS is the same 238.0
      // as MAINS_FIXED_VOLTS, so there is no longer a failure mode that changes
      // the mains figure.
      //
      // The only thing posted from this block is the rail itself, raw.

      if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        inaBusVoltage_V = busV;
        inaShuntVoltage_mV = shuntV;
        inaCurrent_A = inAmps;
        inaPower_W = inWatts;
        xSemaphoreGive(dataMutex);
      }
    }
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
// CORE 0: HIGH-SPEED ZMCT103C SAMPLING TASK
// =========================================================================
void sensorTask(void *pvParameters) {
  (void)pvParameters;

  // Absolute wake time, so METER_INTERVAL_MS is the sweep PERIOD rather than
  // period + sweep duration (a two-channel pass is ~600 ms of blocking
  // conversions, which would otherwise stretch the cycle to 1.6 s).
  TickType_t previousWake = xTaskGetTickCount();
  bool overrunWarned = false;

  for (;;) {
    const uint32_t sweepStartUs = micros();

    // Read every CT-wired ADS1220 channel sequentially (AIN0/AVSS, AIN1/AVSS).
    // The MUX index in CT_MUX[] is the same order as the outlet channel number
    // on this rig, so BRANCH_CT_COUNT drives the loop.
    ZmctReading raw[BRANCH_CT_COUNT];
    float calibrated[BRANCH_CT_COUNT];
    // Per-channel: this window straddled a relay transition and is therefore not
    // a measurement of any steady state. Set below, acted on under dataMutex.
    bool staleDrop[BRANCH_CT_COUNT] = { false, false, false, false };
    bool anyStaleDrop = false;

    for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      // The relay-state stamp, read BEFORE the window opens. applyRelays() on
      // core 1 bumps it the moment any pin level actually changes, so a
      // difference at the end of the window means a transition happened inside
      // it - and a window containing a step is not an RMS of anything, it is the
      // step (see relayStateVersion for the 792 W phantom this exists to stop).
      const uint32_t stampAtWindowStart = relayStateVersion;

      // The SPI lock is taken PER CHANNEL, not around the whole sweep. Each
      // channel window is ~300 ms, so releasing between channels lets anything
      // else that needs SPI get in during the gaps instead of being starved for
      // the full ~600 ms pass.
      //
      // NOTE this is spiMutex, NOT i2cMutex: the CT ADC left the I2C bus when it
      // moved from the ADS1015 to the ADS1220. Holding i2cMutex here would block
      // the core-1 INA226 poll for the entire sweep - it is the exact starvation
      // that lock existed to prevent, aimed at the wrong bus.
      if (xSemaphoreTake(spiMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        raw[ch] = readChannel(ch);
        xSemaphoreGive(spiMutex);
      } else {
        raw[ch] = ZmctReading{0.0f, 0.0f, 0.0f};
      }

      if (relayStateVersion != stampAtWindowStart) {
        // Discard the window. The previous amps are what gets posted this sweep
        // (they are left untouched below), the raw chain is marked stale so the
        // calibration view cannot present the contaminated numbers as real, and
        // calibrated[] is left zero so a stale channel cannot slip into the EMA
        // either. Deliberately NOT latched and NOT retried: the very next
        // window is clean, so one drop per transition is the whole cost.
        staleDrop[ch] = true;
        anyStaleDrop = true;
      } else {
        calibrated[ch] = applyPiecewiseCalibration(raw[ch].amps);
      }
    }

    if (anyStaleDrop) {
      Serial.print("[SWEEP] relay transition inside the window on CH");
      for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
        if (staleDrop[ch]) {
          Serial.print(ch + 1);
          if (ch + 1 < BRANCH_CT_COUNT) Serial.print(",");
        }
      }
      Serial.println(" - window DISCARDED (a step is not an RMS): holding the");
      Serial.println("[SWEEP]   previous amps, raw marked stale. Next sweep is clean.");
    }

    // The sweep must leave IDLE0 a scheduler slot inside every period, or the
    // task watchdog reboots the rig (observed live on 2026-10-15: SensorEngine
    // ran flat out, IDLE0 never ran, WDT aborted the firmware every ~11 s and the
    // board never reached a telemetry POST). Nothing inside a channel window
    // yields, so the bound has to be applied here: if this sweep has eaten its
    // whole period, the next one is shortened rather than skipped.
    //
    // Skipping instead would starve the INA226 and the telemetry far worse, and
    // vTaskDelayUntil() with an already-expired wake time returns immediately -
    // which is precisely how a too-slow sweep turns into a continuous hog. A
    // forced delay is the belt-and-braces answer to that.
    if ((uint32_t)(micros() - sweepStartUs) >= METER_INTERVAL_MS * 1000UL / 2UL) {
      const uint32_t overrun = (uint32_t)(micros() - sweepStartUs);
      if (!overrunWarned) {
        overrunWarned = true;
        Serial.print("[SWEEP] WARNING: pass took ");
        Serial.print(overrun / 1000);
        Serial.print(" ms of a ");
        Serial.print(METER_INTERVAL_MS);
        Serial.println(" ms period. Shortening the window; the ADC is slower than");
        Serial.println("[SWEEP]   ADS_DATA_RATE implies, or DRDY is stretching each read.");
      }
      // Long enough for IDLE0 to run and for loop() to post telemetry, but short
      // enough that the dashboard still sees a fresh reading this second.
      vTaskDelay(pdMS_TO_TICKS(10));
    }

    // Safely update shared global states under mutex protection
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
      for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
        if (staleDrop[ch]) {
          // Publish NOTHING from this channel: branchAmps[ch] keeps its previous
          // value (a stale-but-true number, which is the honest thing to post
          // while the branch is changing state) and the raw chain is zeroed and
          // flagged so the calibration print cannot read a step as signal.
          branchRaw[ch] = ZmctReading{0.0f, 0.0f, 0.0f};
          branchRawStale[ch] = true;
        } else {
          branchAmps[ch] = updateFilteredAmps(calibrated[ch], branchAmps[ch]);
          branchRaw[ch] = raw[ch];
          branchRawStale[ch] = false;
        }
      }
      xSemaphoreGive(dataMutex);
    }

    // Idle until the next scheduled sweep. This task is pinned to core 0, so
    // this is what leaves that core free; core 1 keeps running loop() (serial,
    // INA226 poll, telemetry) throughout.
    vTaskDelayUntil(&previousWake, pdMS_TO_TICKS(METER_INTERVAL_MS));
  }
}

// Single-pass RMS computation across one channel's dedicated ADC samples.
// Takes the CHANNEL INDEX (0-based), not a pin: the channel selects the ADS1220
// MUX, not an ESP32 GPIO.
ZmctReading readChannel(uint8_t channel) {
  double sumRaw = 0.0;
  double sumSqRaw = 0.0;

  // Point the ADC at this branch BEFORE the window, not per sample. setCompareChannels
  // rewrites the MUX field and makes the library re-read the gain field, which is a
  // few SPI round trips - doing that 600 times per window would dominate the pass.
  // It also clamps the PGA for a single-ended (AINx/AVSS) input, so the gain the
  // mV scale below uses is the post-clamp one, not whatever was set at boot.
  ads1220.setCompareChannels(CT_MUX[channel]);

  for (uint16_t i = 0; i < ZMCT_DEDICATED_SAMPLES; i++) {
    // Single-shot, blocking: the library issues START and waits on DRDY (GPIO
    // 14) before clocking out 3 bytes, so each iteration is one conversion. The
    // returned code is the signed 24-bit result, 8388607 = full scale.
    const int32_t rawADC = ads1220.getRawData();
    sumRaw += rawADC;
    sumSqRaw += (double)rawADC * rawADC;
  }

  // Mean-subtracted variance: the CT output sits on a large DC bias, so only
  // the AC ripple around that bias is of interest. Rounding can push a
  // near-constant window slightly negative, hence the clamp.
  double meanRaw = sumRaw / ZMCT_DEDICATED_SAMPLES;
  double variance = (sumSqRaw / ZMCT_DEDICATED_SAMPLES) - (meanRaw * meanRaw);
  if (variance < 0.0) variance = 0.0;

  ZmctReading out;
  out.countsRms = (float)sqrt(variance);
  // Counts -> mV, using the reference and gain the library is actually running
  // with (getVRef_V / getGainFactor), not a hardcoded volts-per-count. This
  // replaced ads.computeVolts(1) from the ADS1015 build: that was a fixed
  // table lookup for a 12-bit ADC whose gain came from a different part, and
  // hardcoding the ADS1220 equivalent instead would bake in the same lie if the
  // reference or gain is ever changed in config.h.
  const float mVPerCount = (ads1220.getVRef_V() * 1000.0f) /
                           (ADS1220_WE::ADS1220_RANGE * static_cast<float>(ads1220.getGainFactor()));
  out.millivoltsRms = out.countsRms * mVPerCount;
  // ZMCT_CAL_FACTOR is amps per volt, so the volts come straight out of the
  // mV reading. NOTE: that factor was measured on the ADS1015 build, not on
  // this ADC - see the warning above it in config.h and re-measure with
  // ZMCT_CALIBRATION_MODE before treating any amps figure as real.
  out.amps = (out.millivoltsRms / 1000.0f) * ZMCT_CAL_FACTOR;
  return out;
}

// Piecewise Calibration: Protects low currents while scaling mid/high range
float applyPiecewiseCalibration(float rawAmps) {
  if (rawAmps < ZMCT_NOISE_FLOOR_AMPS) {
    return 0.0;
  }
  if (rawAmps <= ZMCT_MID_RANGE_AMPS) {
    return rawAmps; // Pass 1:1 on low range
  }
  return rawAmps * ZMCT_MID_RANGE_FACTOR; // ~0.9635, per config.h
}

// Adaptive EMA Filter: Snaps immediately during load changes, smooths steady state
float updateFilteredAmps(float rawAmps, float currentStored) {
  if (fabs(rawAmps - currentStored) > ZMCT_ADAPTIVE_STEP_AMPS) {
    return rawAmps;
  }
  // Weights are ZMCT_ADAPTIVE_EMA_HISTORY old (0.7) / (1 - that) new (0.3).
  return (currentStored * ZMCT_ADAPTIVE_EMA_HISTORY) +
         (rawAmps * (1.0f - ZMCT_ADAPTIVE_EMA_HISTORY));
}

// Watts for one branch. Takes the mains volts as an argument on purpose: both
// the posted voltage and this product come from the SAME snapshot taken under
// one mutex hold, which is what guarantees powerWatts == currentAmps * voltage
// on every branch of every telemetry batch.
float branchWatts(float amps, float mainsVolts) {
  return amps * mainsVolts;
}

// Serial Telemetry Output
void printSerialTelemetry() {
  float inaV, mainsV, inaShunt, inaI, inaP;
  float amps[BRANCH_CT_COUNT];
  ZmctReading raw[BRANCH_CT_COUNT];
  bool stale[BRANCH_CT_COUNT];

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    inaV     = inaBusVoltage_V;
    mainsV   = mainsVolts_V;
    inaShunt = inaShuntVoltage_mV;
    inaI     = inaCurrent_A;
    inaP     = inaPower_W;

    for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      amps[ch] = branchAmps[ch];
      raw[ch]  = branchRaw[ch];
      stale[ch] = branchRawStale[ch];
    }
    xSemaphoreGive(dataMutex);
  } else {
    return;
  }

  Serial.println("==================================================");
  Serial.print("[INA226] Bus: "); Serial.print(inaV, 3);
  Serial.print(" V (3.3V rail expected; ~5 V means the module is on the USB "
                  "rail, ~24 V means it is still on the 24 V rail and must be "
                  "rewired)");
  Serial.print(" | Shunt: "); Serial.print(inaShunt, 3);
  Serial.print(" mV | Current: "); Serial.print(inaI, 3);
  Serial.print(" A | Power: "); Serial.print(inaP, 3); Serial.println(" W");
  Serial.print("[INA226] mains = FIXED constant ");
  Serial.print(MAINS_FIXED_VOLTS, 1);
  Serial.print(" V (NOT bus x ");
  Serial.print(INA226_MAIN_VOLT_DIVIDER);
  Serial.print(" - that divider is unused history) = ");
  Serial.print(mainsV, 1);
  Serial.print(" V (CH1-4 reference) | outlet "); Serial.print(USB_OUTLET_ID);
  Serial.println(" USB is the RAW bus V above");
  Serial.println("--------------------------------------------------");
  // The grid voltage printed here is the one every watt below was multiplied
  // by. Its VALUE is the fixed MAINS_FIXED_VOLTS constant, now 238 V (it was 228 V
// until this pass; the change is adopted from the operator's reference sketch and
// its provenance conflict is recorded in config.h); its PROVENANCE is: it is now the fixed
  // MAINS_FIXED_VOLTS constant, not something derived from the INA226, and it is
  // read from the same snapshot as the amps so the two still agree.
  Serial.print("[ZMCT103C AC Channels @ "); Serial.print(mainsV, 1); Serial.println("V Mains]");
  for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
    Serial.print("  CH"); Serial.print(ch + 1);
    Serial.print(" (AIN"); Serial.print(ch); Serial.print("/AVSS) -> ");
    Serial.print(amps[ch], 3);
    Serial.print(" A | "); Serial.print(branchWatts(amps[ch], mainsV), 1);
    Serial.print(" W | relay CH"); Serial.print(ch + 1);
    Serial.print(" desired="); Serial.print(relayClosedDesired[ch] ? "CLOSED" : "OPEN");
    Serial.print(" pin GPIO"); Serial.print(RELAY_PINS[ch]);
    // The level actually on the pin, read back after the write. This is the
    // whole point of printing it: "desired=OPEN" is what the firmware INTENDS,
    // "pin=LOW" is what the hardware has. If the relay module is active-LOW
    // (RELAY_ACTIVE_LEVEL_INVERTED in config.h) those two disagree, and this
    // line is how that gets noticed on a bench with no one listening for a
    // click. On CH3/CH4 the same readback is how a missing relay is noticed:
    // the pin will read exactly as commanded whether or not a module is
    // attached to it, so only the CT current proves the wiring.
    Serial.print("="); Serial.print(digitalRead(RELAY_PINS[ch]) ? "HIGH" : "LOW");
    // The amps above are HELD, not freshly measured, when the last window for
    // this channel was discarded because a relay moved during it. Say so on the
    // same line as the number it qualifies, so a held reading is never read as a
    // fresh one - this is the one-frame-at-a-time artefact the step-drop causes
    // and it is the price paid for never posting a phantom spike.
    if (stale[ch]) {
      Serial.print(" | raw STALE-DROPPED (relay moved mid-window, previous amps held)");
    }
    Serial.println();
  }
  // ---- outletId 5: the USB socket, monitored on the INA226 ----
  // Printed separately from the CT block because it is NOT a CT reading and
  // comes from a different sensor on a different bus. It has no relay, so
  // there is deliberately no "desired=/pin=" clause: there is nothing to
  // switch, and claiming otherwise would be the firmware lying about hardware
  // it does not have.
  Serial.print("  CH"); Serial.print(USB_OUTLET_ID);
  Serial.print(" (INA226, no CT) -> ");
  Serial.print(inaV, 3);
  Serial.print(" V | "); Serial.print(inaI, 3);
  Serial.print(" A | "); Serial.print(usbWatts(inaV, inaI), 2);
  Serial.print(" W | relay: NONE (monitored-only, always CLOSED) | tier: Low/priority-only");
  Serial.println();

#if ZMCT_CALIBRATION_MODE
  // ---- CT calibration helper (config.h ZMCT_CALIBRATION_MODE 1) ----
  // PRINT ONLY. Nothing in this block feeds back into sampling, the piecewise
  // curve, the EMA, the noise floor or the posted telemetry - it exists so the
  // CT channels can be calibrated against a real known load in one pass instead
  // of by guessing ZMCT_CAL_FACTOR. The factor currently in config.h came off
  // the previous ADS1015 ADC, so on the ADS1220 this is a REQUIRED step, not an
  // optional nicety.
  //
  // It also replaces what the deleted ADS1015 pre-flight used to do: the ADS1X15
  // register decode is gone with the part, so the ADC configuration actually in
  // force is printed here from the library's own state (VREF, gain factor, codes
  // full scale) instead. Those three numbers are what the mV column below was
  // computed with - if they do not match config.h, the mV figures are wrong and
  // NO amount of tuning ZMCT_CAL_FACTOR will fix it.
  static bool calBannerPrinted = false;
  static uint8_t calPrintTick = 0;
  if (!calBannerPrinted) {
    calBannerPrinted = true;
    Serial.println("---- ZMCT103C CALIBRATION (un-calibrated chain) ----");
    Serial.print("[CAL] ADS1220 VREF = "); Serial.print(ads1220.getVRef_V(), 4);
    Serial.print(" V (ADS1220_USE_AVDD_AS_VREF="); Serial.print(ADS1220_USE_AVDD_AS_VREF);
    Serial.println(")");
    Serial.print("[CAL] PGA gain factor = "); Serial.print(ads1220.getGainFactor());
    Serial.print(" (ADS_PGA_GAIN="); Serial.print(ADS_PGA_GAIN);
    Serial.println("; the library clamps this for single-ended AINx/AVSS inputs)");
    Serial.print("[CAL] full scale = "); Serial.print(ADS1220_WE::ADS1220_RANGE, 0);
    Serial.print(" codes -> ");
    Serial.print((ads1220.getVRef_V() * 1000.0f) /
                 (ADS1220_WE::ADS1220_RANGE * (float)ads1220.getGainFactor()), 6);
    Serial.println(" mV per code");
    Serial.print("[CAL] ZMCT_CAL_FACTOR = "); Serial.print(ZMCT_CAL_FACTOR, 4);
    Serial.print(" A/V   ZMCT_CAL_REF_WATTS = "); Serial.print(ZMCT_CAL_REF_WATTS, 1);
    Serial.println(" W  (0 = no reference load applied, so no suggestion is printed)");
    // The channel->input map, once, so a NO SIGNAL on CH3/CH4 can be told apart
    // from a channel that is mapped to the wrong AINx. All four CT channels are
    // live now; outletId 5 is deliberately absent from this table because the
    // USB socket has no CT and is measured by the INA226 instead.
    Serial.print("[CAL] CT channels = ");
    for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      Serial.print(" CH"); Serial.print(ch + 1); Serial.print("->AIN"); Serial.print(ch);
      if (ch + 1 < BRANCH_CT_COUNT) Serial.print(",");
    }
    Serial.print(" | outlet "); Serial.print(USB_OUTLET_ID);
    Serial.println(" = USB socket on INA226 (no CT, no relay) - NOT part of this calibration");
    Serial.println("[CAL] PROCEDURE: clamp ONE known load onto ONE branch, measure its");
    Serial.println("[CAL]   watts with a meter, put that number in ZMCT_CAL_REF_WATTS");
    Serial.println("[CAL]   (config.h) and reflash. Read 'suggested=' below, then write");
    Serial.println("[CAL]   that factor into ZMCT_CAL_FACTOR ALONGSIDE the date and the");
    Serial.println("[CAL]   load used (the provenance block above it), then set");
    Serial.println("[CAL]   ZMCT_CALIBRATION_MODE back to 0 before shipping.");
    Serial.println("[CAL] NO SIGNAL means a wiring/sensor fault, not a factor fault.");
  }
  // The chain itself is throttled to 1 Hz. printSerialTelemetry() runs at 4 Hz,
  // and 4 channels of full chain at 4 Hz buries the boot line, the INA226 line
  // and the telemetry result in the very log this mode exists to read.
  if ((calPrintTick++ % 4) == 0) {
    for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      Serial.print("[CAL] CH"); Serial.print(ch + 1);
      Serial.print(" counts="); Serial.print(raw[ch].countsRms, 1);
      Serial.print(" | mV_rms="); Serial.print(raw[ch].millivoltsRms, 3);
      Serial.print(" mV | @factor="); Serial.print(ZMCT_CAL_FACTOR, 4);
      Serial.print(" -> "); Serial.print(raw[ch].amps, 4);
      Serial.print(" A");
      // Suggested factor: the known load's amps (W / mains volts) divided by the
      // volts the CT actually produced (mV RMS / 1000), i.e. the A/V that would
      // make this channel report exactly ZMCT_CAL_REF_WATTS.
      if (raw[ch].millivoltsRms > 0.0f && mainsV > 0.0f && ZMCT_CAL_REF_WATTS > 0.0f) {
        const float suggested = (ZMCT_CAL_REF_WATTS / mainsV) / (raw[ch].millivoltsRms / 1000.0f);
        Serial.print(" | suggested="); Serial.print(suggested, 4);
        Serial.print(" A/V for "); Serial.print(ZMCT_CAL_REF_WATTS, 1);
        Serial.print(" W (x"); Serial.print(suggested / ZMCT_CAL_FACTOR, 2);
        Serial.println(" current)");
      } else {
        Serial.println();
      }
      // A dead channel and a mis-scaled channel look identical in the amps
      // column - both read far too low - so say which one this is. Chasing
      // ZMCT_CAL_FACTOR when the CT is simply not delivering signal would bake
      // the fault into the constant permanently.
      if (raw[ch].millivoltsRms <= 0.0f) {
        Serial.print("[CAL]   NO SIGNAL on CH"); Serial.print(ch + 1);
        Serial.println(": check the CT, its wiring and the ADC config first.");
      }
    }
  }
#endif
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

// One batch per second. CH1-CH4 carry their measured CT current against the one
// shared mains voltage; outletId 5 (the USB socket) carries the INA226's own bus
// volts and shunt current. Every posted outletId is a channel with a real sensor
// behind it - no zeros, no residuals.
bool postTelemetry() {
  float amps[BRANCH_CT_COUNT];
  float mainsV;
  // The INA226's own readings, taken from the SAME hold as the branch amps and
  // mains volts - the snapshot rule the branch numbers already follow. Read
  // outside the hold they would come from two different polls and the GUI could
  // show a shunt voltage that never coexisted with the current beside it.
  float inaBusV, inaShunt, inaAmps, inaWatts;

  // One hold, one snapshot: the amps posted and the voltage they are multiplied
  // by are read together, so powerWatts == currentAmps * voltage holds exactly.
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      amps[ch] = branchAmps[ch];
    }
    mainsV = mainsVolts_V;
    inaBusV   = inaBusVoltage_V;
    inaShunt  = inaShuntVoltage_mV;
    inaAmps   = inaCurrent_A;
    inaWatts  = inaPower_W;
    xSemaphoreGive(dataMutex);
  } else {
    return false;
  }

  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  // Field NAME is FaultFlag, not sFault: that is what
  // IngestTelemetryCommand exposes (IngestTelemetry.cs:35) and JSON binding is
  // by property name, so "sFault" never bound at all and the fault branch at
  // IngestTelemetry.cs:179 was unreachable - the device could not report a fault
  // it had actually detected. Ported from master 57e3c00 defect 3.
  //
  // The VALUE is false while both sensors are present: no protective rule
  // evaluates in this phase (RULES_ENABLED 0), so the firmware has checked no
  // rule condition at all, and claiming a fault it never evaluated would be as
  // dishonest as claiming none. It is raised exactly when a sensor is missing,
  // which is a condition setup() DID evaluate and can therefore speak to.
  doc["faultFlag"] = !(ina226Present && ads1220Present);
  doc["meteringMode"] = 2;                // 2 = Metered (real sensors are read)

  // The INA226's OWN readings, not derived branch figures. Until now these were
  // serial-only: the dashboard showed branch amps and a mains voltage, and the
  // operator could never see what the sensor actually measured. Values are
  // posted raw - no divider, no averaging, no clamping - because a GUI that
  // re-derives them downstream cannot be wrong about which is which.
  //
  // UNCHANGED WIRE FORMAT, CHANGED MEANING (2026-10-16): these four fields are
  // still busV / shuntmV / currentA / powerW posted from the same one hold as
  // everything else, but the sensor is now the 3.3V RAIL MONITOR rather than
  // the mains voltage reference. busV is EXPECTED TO READ ~3.3 V. If it reads
  // ~5 V the module is on the USB rail, and if it reads ~24 V it is physically
  // still wired to the 24 V rail and must be moved - that number is reported
  // as-is and is not adjusted to look right.
  //
  // mainsVolts_V is the FIXED 238 V constant and stays the basis for every
  // CH1-4 watt; nothing in this block feeds it any more (it used to be
  // busV * INA226_MAIN_VOLT_DIVIDER). This block only reports the sensor.
  //
  // Since the 5-channel expansion the same two figures are ALSO the outletId 5
  // reading below (busV = its volts, currentA = its amps), which is why they are
  // posted raw: the dashboard can show the USB socket's numbers and the sensor
  // block side by side and they must match exactly.
  JsonObject ina = doc["ina"].to<JsonObject>();
  ina["busV"]     = inaBusV;      // V at the INA226 bus pin (~3.3 V rail)
  ina["shuntmV"]  = inaShunt;     // mV across the 0.1 Ohm shunt
  ina["currentA"] = inaAmps;      // A through the shunt
  ina["powerW"]   = inaWatts;     // W at the INA226 bus pin

  JsonArray readings = doc["readings"].to<JsonArray>();
  float totalW = 0.0f;
  for (uint8_t ch = 0; ch < BRANCH_CT_COUNT; ch++) {
    const float watts = branchWatts(amps[ch], mainsV);
    JsonObject r = readings.add<JsonObject>();
    r["outletId"] = ch + 1;
    r["voltage"] = mainsV;
    r["currentAmps"] = amps[ch];
    r["powerWatts"] = watts;
    r["energyKwh"] = 0.0;                // no cumulative counter on this rig
    totalW += watts;
  }
  // ---- outletId 5: the USB socket, measured by the INA226 ----
  // volts = the RAW bus-pin reading, NOT mainsV and NOT busV x the divider. The
  // INA226 IS the 3.3V rail monitor now, so this IS the socket's voltage and
  // is expected to read ~3.3 V; the mains figure is a separate FIXED 238 V constant
  // (MAINS_FIXED_VOLTS) and the old INA226_MAIN_VOLT_DIVIDER is unused history.
  // watts = the product of these same two numbers, taken from
  // the one hold they were both read under, so powerWatts == currentAmps *
  // voltage holds here exactly as it does on CH1-CH4.
  {
    JsonObject u = readings.add<JsonObject>();
    u["outletId"] = USB_OUTLET_ID;
    u["voltage"] = inaBusV;
    u["currentAmps"] = inaAmps;
    u["powerWatts"] = usbWatts(inaBusV, inaAmps);
    u["energyKwh"] = 0.0;                // no cumulative counter on this rig
    // Counted in the total: it is a real measurement of a real rail, so
    // excluding it would under-report the same way a phantom channel did.
    totalW += usbWatts(inaBusV, inaAmps);
  }
  // No extra entry after the loop: outletId 1..BRANCH_CT_COUNT plus USB_OUTLET_ID
  // is the whole rig, and totalW is the sum of every reading above it.

  // Push the desired contact states to the pins before reporting them, so the
  // state the backend is told about is the state the hardware is in when this
  // batch is serialised (not merely intended).
  applyRelays();
  JsonArray relays = doc["relayStates"].to<JsonArray>();
  for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
    JsonObject s = relays.add<JsonObject>();
    s["outletId"] = i + 1;
    // The real desired state, not a hardcoded true. On this rig nothing
    // actuates it yet (RULES_ENABLED 0, no switch inputs), so every entry
    // currently reports true - but it now reports what relayClosedDesired[]
    // holds, which is the same array the pins are driven from, so the day a
    // rule clears a bit the dashboard cannot be told "closed" while the pin is
    // driven LOW. NC contacts: closed == HIGH == power present.
    //
    // The USB entry is pinned true by applyRelays() and reported here as such:
    // it has no relay, so "closed" is not a claim about a switch state, it is a
    // truthful "this outlet is not switched by this device".
    s["relayClosed"] = relayClosedDesired[i];
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
    Serial.printf("telemetry: HTTP %d, total=%.0f W\n", code, totalW);
  }

  // Proof, once per boot, that the `ina` block really is on the wire and not
  // just in the serial log: the first payload this device posts is echoed
  // verbatim. If the block is missing here it is missing on the backend.
  static bool inaPayloadProven = false;
  if (!inaPayloadProven) {
    inaPayloadProven = true;
    Serial.print("telemetry[ina] POST payload: ");
    Serial.println(payload);
    Serial.printf("telemetry[ina] posted: bus=%.3f V shunt=%.3f mV current=%.3f A power=%.3f W\n",
                  inaBusV, inaShunt, inaAmps, inaWatts);
  }
  return ok;
}

// Picks up P_limit, the warning threshold AND the per-outlet desired status, so
// a Disconnect (or a shed / selective response) on the dashboard actually
// reaches the relays.
//
// This function used to read ONLY the two thresholds. That was the whole reason
// disconnect did nothing on the bench: outlets[].desiredStatus was in the JSON
// the whole time, unused, while relayClosedDesired[] kept the value it was
// initialised with (closed) forever. Nothing downstream was broken - the pins
// were driven, the telemetry reported a real desired state - the command simply
// never arrived. A status the device receives and ignores is worse than a
// status it never receives, because the dashboard shows the outlet as
// disconnected while the load is still live.
bool syncConfig() {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, backendUrl("/Device/config"))) {
    // Never silent. This function failing quietly for a whole session is how a
    // disconnect command can sit in the backend forever while the firmware
    // cheerfully reports every outlet as CLOSED and the dashboard shows the
    // load still live.
    Serial.println("[CFG] sync FAILED: could not open the config URL");
    return false;
  }
  // The device endpoints are behind DeviceApiKeyEndpointFilter. Telemetry has
  // always sent the key; config sync did NOT, so as soon as Device:ApiKey was
  // configured the GET was rejected and every desiredStatus silently never
  // arrived. Same key, same header, on both calls - one call that works and one
  // that does not is a bug in the call that does not.
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);

  int code = http.GET();
  if (code != 200) {
    Serial.print("[CFG] sync FAILED: GET /Device/config -> HTTP ");
    Serial.println(code);
    http.end();
    return false;
  }

  // Read the whole body BEFORE parsing. deserializeJson(doc, http.getStream())
  // is the usual ArduinoJson + HTTPClient idiom and it is wrong here: the WiFi
  // stream hands over whatever has arrived at that instant, which on this
  // backend was zero bytes, so every sync died with "InvalidInput" and the
  // desiredStatus never reached the relays. getString() buffers the complete
  // response first.
  const String body = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.print("[CFG] sync FAILED: JSON parse -> ");
    Serial.println(err.c_str());
    return false;
  }

  float limit = doc["criticalThresholdWatts"] | cfgLimit;
  cfgLimit = limit > 0 ? limit : cfgLimit;
  float warn = doc["warningThresholdWatts"] | cfgWarning;
  cfgWarning = warn > 0 ? warn : cfgWarning;

  // ---- Per-outlet desired status -> relay desired state ----
  // channelsSeen counts the outlets actually present in the table so a SHORT
  // table cannot silently re-close every outlet it failed to mention: an outlet
  // missing from the response keeps its current state and is reported, rather
  // than being treated as "not mentioned, therefore on".
  uint8_t channelsSeen = 0;
  bool policyChanged = false;
  JsonArray outlets = doc["outlets"];
  for (JsonObject o : outlets) {
    // channelId is 1-based and is the same number the telemetry posts as
    // outletId, so it maps straight onto relayClosedDesired[channelId - 1].
    const int channelId = o["channelId"] | 0;
    if (channelId < 1 || channelId > OUTLET_COUNT) {
      Serial.print("[RELAY] config lists channel ");
      Serial.print(channelId);
      Serial.println(" - outside OUTLET_COUNT, ignored");
      continue;
    }
    const uint8_t idx = (uint8_t)(channelId - 1);
    // The USB socket (outletId 5) is monitored-only: it has no relay, so a
    // desiredStatus for it cannot be honoured by this device. It is recorded
    // and reported, then IGNORED - acting on it would either drive a
    // placeholder pin to nowhere or, worse, let the dashboard show the socket
    // as disconnected while its load is still drawing. Reporting a Disconnect
    // that was NOT applied is the failure mode this guard exists to prevent, so
    // it is stated explicitly on the bench instead of silently swallowed.
    if (isMonitoredOnly(idx)) {
      const int status = o["desiredStatus"] | -1;
      if (status >= 0) lastDesiredStatus[idx] = (int8_t)status;
      if (status == OUTLET_STATUS_DISCONNECTED) {
        Serial.print("[RELAY] CH"); Serial.print(channelId);
        Serial.println(" (USB socket) has no relay on this rig: desiredStatus="
                       " DISCONNECTED recorded but NOT applied - this device cannot");
        Serial.println("[RELAY]   switch the socket. Cut it at the socket, or fit a");
        Serial.println("[RELAY]   relay and set USB_OUTLET_NO_RELAY 0 in config.h.");
      }
      relayClosedDesired[idx] = true;
      channelsSeen++;
      continue;
    }
    // Missing or non-numeric desiredStatus means "no instruction", NOT "on".
    // Defaulting an absent command to CLOSED is how a shed would be undone by
    // the next poll.
    if (o["desiredStatus"].isNull()) {
      Serial.print("[RELAY] CH"); Serial.print(channelId);
      Serial.println(" has no desiredStatus in the config - keeping current state");
      channelsSeen++;
      continue;
    }
    const int status = o["desiredStatus"].as<int>();
    lastDesiredStatus[idx] = (int8_t)status;
    const bool shouldClose = (status != OUTLET_STATUS_DISCONNECTED);
    const bool wasClosed = relayClosedDesired[idx];
    if (shouldClose != wasClosed) {
      Serial.print("[RELAY] CH"); Serial.print(channelId);
      Serial.print(" backend desiredStatus="); Serial.print(status);
      Serial.print(shouldClose ? " -> CONNECTED (closing)" : " -> DISCONNECTED (opening)");
      relayClosedDesired[idx] = shouldClose;
      policyChanged = true;
      // Drive the pin FIRST, then report it. If the write is what actually
      // fails (bad level, dead module), the log shows the pin level and the
      // operator can see the command did not reach the hardware.
      applyRelays();
      Serial.print(" | pin GPIO");
      Serial.print(RELAY_PINS[idx]);
      Serial.print(" now ");
      Serial.println(digitalRead(RELAY_PINS[idx]) ? "HIGH" : "LOW");
    } else {
      relayClosedDesired[idx] = shouldClose;
    }
    channelsSeen++;
  }

  // Enforce the state even when nothing changed: this is the "apply after
  // config sync" leg, so the pins always reflect the last known policy rather
  // than whatever the last transition happened to leave behind.
  applyRelays();

  // Print the ordinals the device actually parsed, not just the count. A
  // mismatch between what the backend holds and what appears here is the only
  // way to tell "the command never arrived" from "it arrived and was read
  // wrong", and those two look identical from the dashboard.
  if (policyChanged || (++syncCount % 4 == 0)) {
    Serial.printf("config synced: P_limit=%.0f W, %d channels (%u applied) raw status:",
                  cfgLimit, (int)outlets.size(), (unsigned)channelsSeen);
    for (uint8_t i = 0; i < OUTLET_COUNT; i++) {
      Serial.printf(" CH%u=%d(%s)", i + 1, lastDesiredStatus[i],
                    relayClosedDesired[i] ? "CLOSED" : "OPEN");
      // Mark the channel the device is NOT switching, so a reader of this line
      // does not read CH5's CLOSED as "the relay is closed" when no relay
      // exists behind it.
      if (isMonitoredOnly(i)) Serial.print("/no-relay");
    }
    Serial.println();
  }
  return true;
}
