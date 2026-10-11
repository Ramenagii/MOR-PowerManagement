// MOR power-management prototype — ESP32 edge controller.
//
// Each loop iteration the firmware:
//   1. reads the INA226 on the common 220 V mains feed (V / W / energy) and
//      the ADS1015 for per-branch current from each channel's analog CT sensor,
//   2. evaluates the ECA framework rules locally (FR-01..FR-12 twins),
//      but ONLY on a fresh meter sample (no decisions on stale data),
//   3. drives the relay channels (testing rig: 4x220V + 1xUSB 5V),
//   4. POSTs telemetry to the backend and periodically re-syncs config.
//
// The backend (ASP.NET Core + Neon) is the system of record; the ESP32 keeps
// running the last synced policy table when the network drops.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <INA226.h>
#include <Adafruit_ADS1X15.h>

#include "config.h"

// The rig is 4x 220 V outlets (CH1-CH4, each with a CT) + 1x USB 5 V (CH5).
static_assert(OUTLET_COUNT == 5, "config.h: OUTLET_COUNT must be 5 (4x220V + 1xUSB)");
static_assert(BRANCH_CT_COUNT == 4, "config.h: BRANCH_CT_COUNT must be 4 (CH1-CH4)");
static_assert(OUTLET_COUNT <= 16, "desired-state mask is 16 bits");

// Must be defined before the first function: the Arduino IDE auto-generates
// prototypes at the top of the sketch, and a function that takes or returns
// this type fails with "does not name a type" if the struct comes later.
// Snapshot of what is currently in flash, so a config sync that changed
// nothing does not rewrite NVS every CONFIG_INTERVAL_MS (flash wear).
struct PolicySnapshot {
  float limit, warn, standby;
  int stabMs;
  int prio[OUTLET_COUNT];
  float allow[OUTLET_COUNT];
  float volts[OUTLET_COUNT];
  uint16_t mask;
};
PolicySnapshot savedPolicy;
bool savedPolicyValid = false;

// How many consecutive good INA226 reads clear a latched S_fault.
#ifndef FAULT_CLEAR_COUNT
#define FAULT_CLEAR_COUNT 5
#endif

// Desired-state codes from GET /api/Device/config (OutletStatus enum order).
#define DESIRED_ACTIVE 0
#define DESIRED_STANDBY 1

// Mains bus meter: INA226 on the shared I2C bus, fed from the common 220 V
// rail through a divider. Calibrated in setup().
//
// NOTE: the INA226 is a DC monitor (bus pin max 36 V, instantaneous samples).
// The signal reaching it must be isolated, rectified and filtered DC for these
// numbers to mean anything. For true AC RMS volts/watts use a ZMPT101B, or a
// metering IC/module (PZEM-004T, ATM90E26, HLW8012).
INA226 mainsMeter(INA226_ADDR);

// Per-branch current: ADS1015 (12-bit) 4-channel ADC. CH1-CH4 each get an
// analog CT sensor (ZMCT103C-style); the 5V USB rail (CH5) has no CT and is
// reported as the mains total minus the four measured branches (a residual).
Adafruit_ADS1015 branchADC;

// The INA226 has no energy register; integrate power on the device so the
// telemetry still carries a cumulative kWh counter (system total), plus a
// per-channel counter integrated from each channel's own power.
float integratedEnergyWh = 0;
float channelEnergyWh[OUTLET_COUNT] = { 0, 0, 0, 0, 0 };
unsigned long lastEnergyAt = 0;

// True once the INA226 has answered on the bus; false means the rig falls back
// to the nominal line voltage instead of reporting 0 V everywhere.
bool mainsMeterOnline = false;

// Raw INA226 bus reading before the divider is applied. Printed every snapshot
// so the ratio in config.h can be calibrated against a multimeter without
// guessing: true ratio = measured mains volts / lastRawBusVolts.
float lastRawBusVolts = 0;

// Latest mains watts (INA226 x divider), for the serial display.
float lastMainsW = 0;

// True once the ADS1015 has answered. This guard is not cosmetic: the
// Adafruit ADS1x15 driver busy-waits in readADC_SingleEnded() with no timeout
// (`while (!conversionComplete());`), so a single read against a missing
// device spins forever and kills the whole main loop. Nothing may call the
// ADC unless the chip was seen at boot.
bool branchAdcOnline = false;

// Set by readMeters() when it produced a fresh sample. Policies are evaluated
// only on a fresh sample; otherwise a just-shed channel's old power is still in
// the total and the next 200 ms loop would shed another channel, and another.
bool newSample = false;

// Set to bypass the METER_INTERVAL_MS gate once (FR-06 post-activation check
// needs a genuinely new reading after the stabilization delay).
bool forceNextSweep = false;

// EMA-filtered branch current in amps RMS, one per outlet channel. Channels
// without a CT wired stay at 0.
float measuredBranchA[OUTLET_COUNT] = { 0, 0, 0, 0, 0 };

// True AC RMS current for one ADS1015 channel, in amps.
//
// Single pass over ZMCT_DEDICATED_SAMPLES using E[x^2] - mean^2, which removes
// the CT module's ~2.5 V DC bias without a separate offset window: the bias
// cancels out of the variance. computeVolts(1) is the volts-per-count scale for
// the gain the driver is currently set to, so this stays correct if the gain
// changes. 600 samples at 3300 SPS is ~182 ms, about 11 AC cycles at 60 Hz.
//
// The ZMCT module must run from the same supply as the ADS (3.3 V) so its bias
// cannot exceed ADS VDD + 0.3 V.
float readChannelRMS(uint8_t channel) {
  double sumRaw = 0.0;
  double sumSqRaw = 0.0;

  for (uint16_t i = 0; i < ZMCT_DEDICATED_SAMPLES; i++) {
    int16_t raw = branchADC.readADC_SingleEnded(channel);
    sumRaw += raw;
    sumSqRaw += (double)raw * raw;
  }

  double meanRaw = sumRaw / ZMCT_DEDICATED_SAMPLES;
  double variance = (sumSqRaw / ZMCT_DEDICATED_SAMPLES) - (meanRaw * meanRaw);
  if (variance < 0.0) variance = 0.0;  // float round-off can push this negative

  float voltsRMS = sqrt(variance) * branchADC.computeVolts(1);
  return voltsRMS * ZMCT_CAL_FACTOR;
}

// Piecewise calibration: the CT module is accurate at the low end and
// over-reports slightly above ~80 mA, so the mid/high range carries its own
// factor. The noise gate keeps an unplugged channel at a clean 0.000 A instead
// of floating milliamps that would read as a live load.
float applyPiecewiseCalibration(float rawAmps) {
  if (rawAmps < ZMCT_NOISE_FLOOR_AMPS) return 0.0f;
  if (rawAmps <= ZMCT_MID_RANGE_AMPS) return rawAmps;
  return rawAmps * ZMCT_MID_RANGE_FACTOR;
}

// Adaptive filter: snap straight through when the step is large enough to be a
// real load change, otherwise smooth it. A fixed EMA always lags a load step,
// which on the console reads as a number that never settles.
float updateFilteredAmps(float rawAmps, float stored) {
  if (fabs(rawAmps - stored) > ZMCT_ADAPTIVE_STEP_AMPS) return rawAmps;
  return (stored * ZMCT_ADAPTIVE_EMA_HISTORY)
       + (rawAmps * (1.0f - ZMCT_ADAPTIVE_EMA_HISTORY));
}

/*
 * Sampling engine — pinned to core 0.
 *
 * A full four-channel pass is ~730 ms at 600 samples each. Run on the main loop
 * that would delay serial output, the config poll and telemetry, which is the
 * stalling this replaces. On its own core the console prints at full rate while
 * acquisition runs continuously.
 */
void sensorTask(void *pvParameters) {
  float raw[BRANCH_CT_COUNT > 0 ? BRANCH_CT_COUNT : 1];
  for (;;) {
    for (int ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      raw[ch] = applyPiecewiseCalibration(readChannelRMS(ch));
    }
    for (int ch = 0; ch < BRANCH_CT_COUNT; ch++) {
      measuredBranchA[ch] = updateFilteredAmps(raw[ch], measuredBranchA[ch]);
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

struct ChannelState {
  float voltage = 0;
  float current = 0;
  float power = 0;
  float energy = 0;
  bool relayClosed = false;
  bool localShed = false;
  bool overcurrentTripped = false;  // FR-03 latch, cleared by config sync
  uint8_t faultStreak = 0;
  bool switchLast = HIGH;
  unsigned long switchChangedAt = 0;
};

ChannelState channels[OUTLET_COUNT];

// Synced policy table (backend is the authority). Boot defaults match the
// testing rig: 4x300 W 220 V outlets + 1x10 W USB 5 V rail, P_limit 1200 W.
// CH5 is a USB-A 5V/2.1A port, so 10 W is the honest ceiling (5V x 2.1A);
// a larger allowance would authorise a load the port cannot serve.
float cfgLimit = 1200;       // P_limit (testing rig cap)
float cfgWarning = 960;
float cfgStandby = 80;
int cfgStabilizationMs = 500;
// Boot defaults for the testing rig (MUST_READ.md): 4x300 W 220 V outlets
// (CH1 Critical, CH2-CH3 High, CH4 Medium) + one 10 W USB 5 V rail (CH5 Low).
// All three tables are overwritten by GET /api/Device/config on the first sync,
// so these only govern behaviour before the backend is reached.
int prioRank[OUTLET_COUNT] = { 3, 2, 2, 1, 0 };
float allowanceW[OUTLET_COUNT] = { 300, 300, 300, 300, 10 };
// Nominal volts at each channel's own output. CH1-CH4 sit on the mains bus and
// report the measured INA226 value; CH5 is on the 5 V buck rail and reports its
// own nominal, so quoting the mains reading there would be wrong.
float ratedVolts[OUTLET_COUNT] = { 220, 220, 220, 220, 5 };
bool desiredEnergized[OUTLET_COUNT] = { false, false, false, false, false };
bool configSynced = false;

// On-device copy of the policy table (NVS flash). The protection logic runs
// from this copy, so the prototype enforces the last synced policy even with
// no network, and resumes it immediately on power-up.
Preferences nvsPolicy;
const uint32_t POLICY_MAGIC = 0x4D4F5232;  // "MOR2": 16-bit desired mask, up to 16 channels
unsigned long missedPosts = 0;

bool sFault = false;
uint8_t faultRecoverStreak = 0;
unsigned long lastTelemetryAt = 0;
unsigned long lastConfigAt = 0;
unsigned long lastSnapshotAt = 0;

// ---- Multi-WiFi store (NVS "morwifi"): up to WIFI_SLOTS networks. ----
Preferences nvsWifi;
char wifiSsid[WIFI_SLOTS][33];
char wifiPass[WIFI_SLOTS][65];
int wifiLastOk = 0;

void loadWifiSlots() {
  for (int i = 0; i < WIFI_SLOTS; i++) {
    wifiSsid[i][0] = 0;
    wifiPass[i][0] = 0;
  }
  wifiLastOk = 0;
  nvsWifi.begin("morwifi", true);
  for (int i = 0; i < WIFI_SLOTS; i++) {
    String s = nvsWifi.getString(("ssid" + String(i)).c_str(), "");
    String p = nvsWifi.getString(("pass" + String(i)).c_str(), "");
    s.toCharArray(wifiSsid[i], 33);
    p.toCharArray(wifiPass[i], 65);
  }
  wifiLastOk = nvsWifi.getInt("lastok", 0);
  nvsWifi.end();
  // First boot ever: seed slot 0 from config.h (usually empty placeholders).
  if (wifiSsid[0][0] == 0 && WIFI_SSID[0] != 0) {
    strncpy(wifiSsid[0], WIFI_SSID, 32);
    strncpy(wifiPass[0], WIFI_PASS, 64);
  }
  if (wifiLastOk < 0 || wifiLastOk >= WIFI_SLOTS) wifiLastOk = 0;
}

void saveWifiSlots() {
  nvsWifi.begin("morwifi", false);
  for (int i = 0; i < WIFI_SLOTS; i++) {
    nvsWifi.putString(("ssid" + String(i)).c_str(), wifiSsid[i]);
    nvsWifi.putString(("pass" + String(i)).c_str(), wifiPass[i]);
  }
  nvsWifi.putInt("lastok", wifiLastOk);
  nvsWifi.end();
}

bool tryJoin(const char* ssid, const char* pass) {
  if (ssid[0] == 0) return false;
  Serial.printf("Wi-Fi trying \"%s\" ", ssid);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  delay(200);
  if (pass[0] == 0) {
    WiFi.begin(ssid);
  } else {
    WiFi.begin(ssid, pass);
  }
  unsigned long deadline = millis() + WIFI_JOIN_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("wifi: join failed \"%s\" status=%d\n", ssid, (int)WiFi.status());
    return false;
  }
  return true;
}

String backendUrl(const char* path) {
#if BACKEND_USE_TLS
  String url = "https://";
#else
  String url = "http://";
#endif
  url += BACKEND_HOST;
  url += ":";
  url += BACKEND_PORT;
  url += BACKEND_BASE;
  url += path;
  return url;
}

void applyRelays() {
  for (int i = 0; i < OUTLET_COUNT; i++) {
    bool closed = !sFault && desiredEnergized[i] && !channels[i].localShed;
    channels[i].relayClosed = closed;
#if RELAY_OUTPUT_ENABLED
    // NC contact: HIGH leaves the coil idle and power flowing; LOW is what
    // actually cuts this channel.
    digitalWrite(RELAY_PINS[i], closed ? RELAY_POWER_ON_LEVEL : RELAY_POWER_OFF_LEVEL);
#endif
  }
}

float totalLoad() {
  float total = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) total += channels[i].power;
  return total;
}

void readMeters() {
  // The real-hardware path blocks for ~184 ms per CT channel, so it runs on
  // its own cadence instead of every loop iteration. Without this the loop
  // spends nearly all its time inside the RMS window and the 5 s telemetry tick
  // is starved. forceNextSweep bypasses the gate exactly once.
#if !SIMULATE_METERS
  static unsigned long lastSweepAt = 0;
  unsigned long sweepNow = millis();
  if (!forceNextSweep && lastSweepAt != 0 && sweepNow - lastSweepAt < METER_INTERVAL_MS) {
    return;  // keep the previous sample; the dashboard is 1 Hz either way
  }
  forceNextSweep = false;
  lastSweepAt = sweepNow;
#endif

#if SIMULATE_METERS
  // Placeholder: no I2C sensors wired. Synthesize a plausible mains load from the
  // energized channels so the full telemetry -> dashboard loop can be tested.
  static unsigned long simLastAt = 0;
  unsigned long simNow = millis();
  float simHours = simLastAt ? (simNow - simLastAt) / 3600000.0f : 0.0f;
  simLastAt = simNow;
  float simDenom = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (channels[i].relayClosed || desiredEnergized[i]) simDenom += allowanceW[i];
  }
  float simTotal = simDenom * 0.72;  // mirrors the backend activation estimate
  integratedEnergyWh += simTotal * simHours;
  lastMainsW = simTotal;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    channels[i].voltage = ratedVolts[i];
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].power = simDenom > 0 ? simTotal * (allowanceW[i] / simDenom) : 0;
      channels[i].current = channels[i].voltage > 0 ? channels[i].power / channels[i].voltage : 0;
    } else {
      channels[i].current = 0;
      channels[i].power = 0;
    }
    channelEnergyWh[i] += channels[i].power * simHours;
    channels[i].energy = channelEnergyWh[i] / 1000.0f;
  }
  channels[0].faultStreak = 0;
  newSample = true;
  return;
#endif
  // ---- Real hardware: INA226 (mains feed) + ADS1015 (per-branch CTs) ----
  // Real mains volts from the INA226. If the chip is not answering at all, fall
  // back to the nominal so the rig still reports sensible volts instead of 0 V
  // on every channel, but keep saying so on serial.
  float mainsV;
  float mainsW = 0;
  if (mainsMeterOnline) {
    // The divider is applied HERE, not via configure()'s bus_V_scaling_e4:
    // that field is a uint16 scaled by 1e4, so it tops out at 6.5535 and a
    // 220 V ladder cannot be expressed through it. Reading raw and scaling in
    // firmware keeps the ratio exact and adjustable in one place.
    float rawV = mainsMeter.getBusVoltage();
    mainsV = rawV * INA226_MAIN_VOLT_DIVIDER;
    mainsW = mainsMeter.getPower() * INA226_MAIN_VOLT_DIVIDER;
    lastRawBusVolts = rawV;
    if (isnan(mainsV) || mainsV < 1.0f) {
      // Present but unreadable: that is a real sensor fault (FR-01).
      faultRecoverStreak = 0;
      channels[0].faultStreak++;
      lastEnergyAt = 0;  // do not integrate across the outage on recovery
      if (channels[0].faultStreak >= FAULT_TRIP_COUNT && !sFault) {
        sFault = true;
        Serial.println("FR-01: S_fault TRUE (INA226 unreadable), all relays opened");
      }
      return;
    }
  } else {
    mainsV = FALLBACK_MAINS_VOLTS;
  }
  channels[0].faultStreak = 0;

  // FR-01 recovery: the fault is not permanent. Once the meter reads sane again
  // for FAULT_CLEAR_COUNT consecutive samples, clear it and let policy resume.
  if (sFault) {
    if (++faultRecoverStreak >= FAULT_CLEAR_COUNT) {
      sFault = false;
      faultRecoverStreak = 0;
      Serial.println("FR-01: S_fault cleared (INA226 reading normally again)");
    }
  } else {
    faultRecoverStreak = 0;
  }

  lastMainsW = mainsW;

  // Time slice for energy integration (INA226 has no cumulative counter).
  unsigned long nowMs = millis();
  float hours = 0.0f;
  if (lastEnergyAt != 0) hours = (nowMs - lastEnergyAt) / 3600000.0f;
  lastEnergyAt = nowMs;
  integratedEnergyWh += mainsW * hours;

  // Per-branch AC current is produced by the core-0 sampling task; this loop
  // only consumes the latest filtered value. Channels without a CT wired stay
  // at 0 A rather than reporting ADC noise, so the console can tell a measured
  // branch from an unmeasured one.
  for (int ch = 0; ch < OUTLET_COUNT; ch++) {
    if (ch >= BRANCH_CT_COUNT || !branchAdcOnline) {
      measuredBranchA[ch] = 0.0f;
    }
  }

  // Branch power = branch current x branch volts. CH1-CH4 sit on the mains bus
  // and report the measured INA226 voltage; CH5 (USB 5 V) reports its own
  // nominal so its amps are consistent with what it actually carries.
  for (int i = 0; i < OUTLET_COUNT; i++) {
    bool mainsBus = fabsf(ratedVolts[i] - 220.0f) < 1.0f;
    channels[i].voltage = mainsBus ? mainsV : ratedVolts[i];
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].current = measuredBranchA[i];
      channels[i].power = channels[i].voltage * measuredBranchA[i];
    } else {
      channels[i].current = 0;
      channels[i].power = 0;
    }
  }

  // The USB rail (CH5) has no CT. Report its load as the residual: the mains
  // total less what the measured branches already account for, never negative.
  // It is an ESTIMATE: meter error and buck-converter loss land here, so it is
  // clamped to the port's physical ceiling (allowanceW, 5 V x 2.1 A = 10 W)
  // instead of showing a fake 50 W USB load.
  if (OUTLET_COUNT > 4) {
    int last = OUTLET_COUNT - 1;
    float branchSumW = 0;
    for (int i = 0; i < last; i++) branchSumW += channels[i].power;
    float residualW = mainsW - branchSumW;
    if (residualW < 0) residualW = 0;
    if (residualW > allowanceW[last]) residualW = allowanceW[last];
    if (channels[last].relayClosed || desiredEnergized[last]) {
      channels[last].power = residualW;
      channels[last].current = channels[last].voltage > 0 ? residualW / channels[last].voltage : 0;
    }
  }

  // Per-channel energy from each channel's own power (not the system total).
  for (int i = 0; i < OUTLET_COUNT; i++) {
    channelEnergyWh[i] += channels[i].power * hours;
    channels[i].energy = channelEnergyWh[i] / 1000.0f;  // kWh
  }

  newSample = true;
}

// FR-07: lowest priority rank first, ties broken by higher draw.
int pickShedCandidate() {
  int pick = -1;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (!channels[i].relayClosed || channels[i].localShed) continue;
    if (pick < 0 || prioRank[i] < prioRank[pick] ||
        (prioRank[i] == prioRank[pick] && channels[i].power > channels[pick].power)) {
      pick = i;
    }
  }
  return pick;
}

// Call only when newSample is true (see loop()).
void evaluateLocalPolicies() {
#if !RULES_ENABLED
  // Raw test mode: the framework must not shed, trip or deny anything while the
  // measurement chain is being proven. The console still reports what the rules
  // WOULD have seen, so a fault can be rehearsed without moving a relay.
  return;
#else
  if (sFault) return;

  // FR-03 branch overcurrent protection. Checked per branch before the system
  // total, because a single overloaded channel is a fault even when the rig as
  // a whole is under P_limit. Latches: the branch stays cut until the config
  // sync clears it, matching the manual reset in the original bench sketch.
  for (int i = 0; i < BRANCH_CT_COUNT && i < OUTLET_COUNT; i++) {
    if (!channels[i].overcurrentTripped && channels[i].current >= BRANCH_OVERCURRENT_AMPS) {
      channels[i].overcurrentTripped = true;
      channels[i].localShed = true;
      Serial.printf("FR-03: channel %d overcurrent %.2f A >= %.2f A, power CUT\n",
                    i + 1, channels[i].current, BRANCH_OVERCURRENT_AMPS);
    }
  }

  float total = totalLoad();

  if (LOCAL_AUTO_SHED && total > cfgLimit) {
    int pick = pickShedCandidate();
    if (pick >= 0) {
      channels[pick].localShed = true;
      Serial.printf("FR-07: P_total %.0f W > P_limit %.0f W, shed channel %d\n",
                    total, cfgLimit, pick + 1);
    }
  }

  // Release local sheds once headroom is back, but never release an
  // overcurrent trip on its own: that latch is cleared deliberately.
  if (total <= cfgWarning) {
    for (int i = 0; i < OUTLET_COUNT; i++) {
      if (!channels[i].overcurrentTripped) channels[i].localShed = false;
    }
  }
#endif  // RULES_ENABLED
}

void handleManualSwitch(int i) {
  uint8_t pin = SWITCH_PINS[i];
  if (pin == 0) return;

  bool level = digitalRead(pin);
  unsigned long now = millis();
  if (level != channels[i].switchLast && now - channels[i].switchChangedAt > SWITCH_DEBOUNCE_MS) {
    channels[i].switchChangedAt = now;
    channels[i].switchLast = level;

    if (level == LOW && !channels[i].relayClosed && !sFault) {
      // FR-04 / FR-05 pre-activation assessment.
      float projected = totalLoad() + allowanceW[i];
      if (projected > cfgLimit) {
        Serial.printf("FR-05: channel %d request denied (%.0f W + %.0f W > %.0f W)\n",
                      i + 1, totalLoad(), allowanceW[i], cfgLimit);
        return;
      }
      Serial.printf("FR-04: channel %d allowed, closing relay\n", i + 1);
      desiredEnergized[i] = true;
      applyRelays();
      delay(cfgStabilizationMs);
      forceNextSweep = true;  // FR-06 needs a real post-activation reading
      readMeters();
      // FR-06 post-activation verification.
      if (totalLoad() > cfgLimit) {
        channels[i].localShed = true;
        Serial.printf("FR-06: channel %d verification failed, shed\n", i + 1);
      }
      applyRelays();
    }
  }
}

PolicySnapshot currentPolicy() {
  PolicySnapshot p;
  p.limit = cfgLimit;
  p.warn = cfgWarning;
  p.standby = cfgStandby;
  p.stabMs = cfgStabilizationMs;
  p.mask = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    p.prio[i] = prioRank[i];
    p.allow[i] = allowanceW[i];
    p.volts[i] = ratedVolts[i];
    if (desiredEnergized[i]) p.mask |= (uint16_t)(1u << i);
  }
  return p;
}

bool policyEqual(const PolicySnapshot& a, const PolicySnapshot& b) {
  if (a.limit != b.limit || a.warn != b.warn || a.standby != b.standby ||
      a.stabMs != b.stabMs || a.mask != b.mask) return false;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (a.prio[i] != b.prio[i] || a.allow[i] != b.allow[i] || a.volts[i] != b.volts[i]) return false;
  }
  return true;
}

// Returns true if flash was actually written.
bool savePolicyTable() {
  PolicySnapshot cur = currentPolicy();
  if (savedPolicyValid && policyEqual(cur, savedPolicy)) return false;  // nothing changed

  nvsPolicy.begin("mor", false);
  nvsPolicy.putUInt("magic", POLICY_MAGIC);
  nvsPolicy.putFloat("limit", cfgLimit);
  nvsPolicy.putFloat("warn", cfgWarning);
  nvsPolicy.putFloat("standby", cfgStandby);
  nvsPolicy.putInt("stabMs", cfgStabilizationMs);
  uint8_t prio[OUTLET_COUNT];
  for (int i = 0; i < OUTLET_COUNT; i++) prio[i] = (uint8_t)prioRank[i];
  nvsPolicy.putBytes("prio", prio, OUTLET_COUNT);
  nvsPolicy.putBytes("allow", allowanceW, sizeof(allowanceW));
  nvsPolicy.putBytes("volts", ratedVolts, sizeof(ratedVolts));
  nvsPolicy.putUShort("desired", cur.mask);
  nvsPolicy.end();

  savedPolicy = cur;
  savedPolicyValid = true;
  return true;
}

bool loadPolicyTable() {
  nvsPolicy.begin("mor", true);
  uint32_t magic = nvsPolicy.getUInt("magic", 0);
  if (magic != POLICY_MAGIC) {
    nvsPolicy.end();
    return false;
  }
  cfgLimit = nvsPolicy.getFloat("limit", cfgLimit);
  cfgWarning = nvsPolicy.getFloat("warn", cfgWarning);
  cfgStandby = nvsPolicy.getFloat("standby", cfgStandby);
  cfgStabilizationMs = nvsPolicy.getInt("stabMs", cfgStabilizationMs);
  uint8_t prio[OUTLET_COUNT];
  if (nvsPolicy.getBytes("prio", prio, OUTLET_COUNT) == OUTLET_COUNT) {
    for (int i = 0; i < OUTLET_COUNT; i++) prioRank[i] = prio[i];
  }
  float allow[OUTLET_COUNT];
  if (nvsPolicy.getBytes("allow", allow, sizeof(allow)) == sizeof(allow)) {
    memcpy(allowanceW, allow, sizeof(allow));
  }
  // Absent in tables written before rated volts were tracked; keep the
  // compiled rig defaults in that case rather than zeroing the channels.
  float volts[OUTLET_COUNT];
  if (nvsPolicy.getBytes("volts", volts, sizeof(volts)) == sizeof(volts)) {
    memcpy(ratedVolts, volts, sizeof(volts));
  }
  uint16_t mask = nvsPolicy.getUShort("desired", 0);
  for (int i = 0; i < OUTLET_COUNT; i++) desiredEnergized[i] = (mask & (1u << i)) != 0;
  nvsPolicy.end();

  savedPolicy = currentPolicy();
  savedPolicyValid = true;
  return true;
}

bool syncConfig() {
#if BACKEND_USE_TLS
  WiFiClientSecure client;
  client.setInsecure();  // Prototype LAN: dev cert is not publicly verifiable.
#else
  WiFiClient client;
#endif
  HTTPClient http;
  if (!http.begin(client, backendUrl("/Device/config"))) return false;
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);

  int code = http.GET();
  if (code != 200) {
    Serial.printf("config sync failed: HTTP %d\n", code);
    http.end();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, http.getString())) {
    http.end();
    return false;
  }
  http.end();

  cfgLimit = doc["criticalThresholdWatts"] | cfgLimit;
  cfgWarning = doc["warningThresholdWatts"] | cfgWarning;
  cfgStandby = doc["standbyThresholdWatts"] | cfgStandby;
  cfgStabilizationMs = doc["stabilizationDelayMs"] | cfgStabilizationMs;

  JsonArray outlets = doc["outlets"];
  for (JsonObject o : outlets) {
    int ch = (int)o["channelId"] - 1;
    if (ch < 0 || ch >= OUTLET_COUNT) continue;
    prioRank[ch] = o["priority"] | 1;
    allowanceW[ch] = o["allowanceWatts"] | 0.0f;
    ratedVolts[ch] = o["ratedVoltageVolts"] | ratedVolts[ch];
    int desired = o["desiredStatus"] | 3;
    bool wasEnergized = desiredEnergized[ch];
    desiredEnergized[ch] = (desired == DESIRED_ACTIVE || desired == DESIRED_STANDBY);
    // A branch the backend still wants energised after a trip means an operator
    // has reviewed it: clear the FR-03 latch, the same as the manual reset.
    if (desiredEnergized[ch] && !wasEnergized && channels[ch].overcurrentTripped) {
      channels[ch].overcurrentTripped = false;
      channels[ch].localShed = false;
      Serial.printf("FR-03: channel %d trip cleared by Decision Point\n", ch + 1);
    }
  }

  configSynced = true;
  Serial.printf("config synced: P_limit=%.0f W, %d channels\n", cfgLimit, outlets.size());
  if (savePolicyTable()) Serial.println("policy table changed, stored to flash");
  return true;
}

bool postTelemetry() {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["faultFlag"] = sFault;
  doc["missedPosts"] = missedPosts;

#ifdef REPORT_METERING_MODE
  // Provenance for the values in this batch: 1 = Simulated (SIMULATE_METERS),
  // 2 = Metered (a real INA226 + ADS1015 sit on the bench).
  doc["meteringMode"] = SIMULATE_METERS ? 1 : 2;
#endif

  JsonArray readings = doc["readings"].to<JsonArray>();
  JsonArray relays = doc["relayStates"].to<JsonArray>();
  for (int i = 0; i < OUTLET_COUNT; i++) {
    JsonObject r = readings.add<JsonObject>();
    r["outletId"] = i + 1;
    r["voltage"] = channels[i].voltage;
    r["currentAmps"] = channels[i].current;
    r["powerWatts"] = channels[i].power;
    r["energyKwh"] = channels[i].energy;

    JsonObject s = relays.add<JsonObject>();
    s["outletId"] = i + 1;
    s["relayClosed"] = channels[i].relayClosed;
  }

  String payload;
  serializeJson(doc, payload);

#if BACKEND_USE_TLS
  WiFiClientSecure client;
  client.setInsecure();
#else
  WiFiClient client;
#endif
  HTTPClient http;
  if (!http.begin(client, backendUrl("/Device/telemetry"))) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) http.addHeader("X-Device-Key", DEVICE_API_KEY);

  int code = http.POST(payload);
  bool ok = code >= 200 && code < 300;
  if (ok) {
    missedPosts = 0;
  } else {
    missedPosts++;
  }
  Serial.printf("telemetry: HTTP %d, total=%.0f W%s\n",
                code, totalLoad(), sFault ? " FAULT" : "");
  http.end();
  return ok;
}

// Serial monitor table: one row per channel, then system totals.
// CH1-CH4 = 220 V outlets (CT-measured), CH5 = USB 5 V (residual estimate).
// Driven from loop() rather than postTelemetry() so the bench stays
// observable when the backend is unreachable - a device that only reports
// while online is unverifiable exactly when something has gone wrong.
void printChannelSnapshot() {
  Serial.println("---------------------------------------------");
  for (int i = 0; i < OUTLET_COUNT; i++) {
    Serial.printf(" CH%d %-5s %-4s %7.1f W  %6.3f A  %5.1f V%s\n",
                  i + 1,
                  i < BRANCH_CT_COUNT ? "220V" : "USB5V",
                  channels[i].relayClosed ? "ON" : "OFF",
                  channels[i].power, channels[i].current, channels[i].voltage,
                  (i < BRANCH_CT_COUNT) ? "" : "  (residual est.)");
  }
  Serial.printf(" TOTAL %.1f W | limit %.0f W | mains %.1f W | %.4f kWh%s\n",
                totalLoad(), cfgLimit, lastMainsW, integratedEnergyWh / 1000.0f,
                sFault ? " | FAULT" : "");
  if (mainsMeterOnline) {
    // Calibration aid: true divider ratio = measured mains V / raw V.
    Serial.printf(" INA226 raw %.2f V x%.1f = %.1f V\n",
                  lastRawBusVolts, INA226_MAIN_VOLT_DIVIDER,
                  lastRawBusVolts * INA226_MAIN_VOLT_DIVIDER);
  }
}

// Count and print every device answering on the I2C bus. Used at boot so a
// wiring, pull-up or addressing mistake shows up as a clear serial line instead
// of a silent 0 A reading on the dashboard.
uint8_t scanI2CBus(const char* label) {
  uint8_t found = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("i2c[%s]: device responding at 0x%02X\n", label, addr);
      found++;
    }
  }
  return found;
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nMOR power-management prototype starting");
#if !RELAY_OUTPUT_ENABLED || !RULES_ENABLED || !TELEMETRY_ENABLED
  Serial.println("RAW TEST MODE: relays, rules and telemetry are disabled - console only");
#endif

  // Restore the stored policy BEFORE touching the relay pins, so each channel
  // is driven straight to its last desired state. (The old order powered every
  // relay ON and then cut them a few ms later, which clicked the loads.)
  if (loadPolicyTable()) {
    Serial.printf("policy restored from flash: P_limit=%.0f W\n", cfgLimit);
  } else {
    Serial.println("no stored policy, using compiled defaults until first sync");
  }

  for (int i = 0; i < OUTLET_COUNT; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    if (SWITCH_PINS[i] != 0) pinMode(SWITCH_PINS[i], INPUT_PULLUP);
  }
  applyRelays();
#ifdef LED_BUILTIN
  pinMode(LED_BUILTIN, OUTPUT);
#endif

#if SIMULATE_METERS
  Serial.println("SIM mode: synthetic mains readings (no INA226/ADS1015 wired)");
#else
  // Real sensing path: one shared I2C bus carrying the INA226 (mains feed) and
  // the ADS1015 (four per-branch CT channels).
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

#if DIAG_PIN_HUNT
  // Pin hunt: the terminal block exposes many GPIOs and it is easy to land the
  // I2C pair one screw position off. Try each plausible pair and report what
  // answers, so the correct pair is measured rather than assumed. Diagnostic
  // only: prints and then continues with the normal path.
  {
    const uint8_t pairs[][2] = {
      {8, 9}, {9, 8}, {17, 18}, {16, 17}, {4, 5}, {15, 16}, {1, 2}, {38, 39},
    };
    Serial.println("--- I2C pin hunt ---");
    for (size_t p = 0; p < sizeof(pairs) / sizeof(pairs[0]); p++) {
      const uint8_t sda = pairs[p][0];
      const uint8_t scl = pairs[p][1];
      Wire.end();
      delay(20);
      Wire.begin(sda, scl);
      delay(50);
      uint8_t hits = 0;
      String list;
      for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
          if (hits == 0) {
            list = " ";
          }
          list += String(addr, HEX);
          list += " ";
          hits++;
        }
      }
      Serial.printf("SDA=%2u SCL=%2u -> %u device(s)%s\n", sda, scl, hits,
                    hits ? list.c_str() : "");
    }
    Serial.println("--- pin hunt done ---");
    Wire.end();
    delay(20);
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    delay(50);
  }
#endif

  // I2C bus inventory. Sensors on a breadboard rail can take a moment to come
  // up, so scan once immediately and once after a second: if the second scan
  // finds devices the first missed, that is a power-up timing problem, and if
  // both find nothing it is wiring, pull-ups or sensor power.
  uint8_t foundDevices = scanI2CBus("boot");
  if (foundDevices == 0) {
    delay(1000);
    foundDevices = scanI2CBus("retry");
  }
  if (foundDevices == 0) {
    Serial.printf("i2c: NO devices responded on SDA=%d SCL=%d - check wiring, pull-ups and sensor power\n",
                  I2C_SDA_PIN, I2C_SCL_PIN);
  }

  if (!mainsMeter.begin()) {
    Serial.printf("INA226 not found at 0x%02X on SDA=%d SCL=%d - falling back to %.0f V nominal\n",
                  INA226_ADDR, I2C_SDA_PIN, I2C_SCL_PIN, FALLBACK_MAINS_VOLTS);
    mainsMeterOnline = false;
  } else {
    // configure(shunt_ohm, current_LSB_mA, zero_offset_mA, bus_V_scaling_e4).
    // The shunt is 0.1 ohm / 100 mA LSB. Bus scaling is left at 1.0 (10000)
    // because the 220 V divider is applied in firmware; the field is a uint16
    // scaled by 1e4 and cannot represent a ratio above 6.5535.
    mainsMeter.configure(0.1, 0.1, 0, 10000);
    mainsMeterOnline = true;
    Serial.printf("INA226 online at 0x%02X (mains meter, divider %.1fx)\n",
                  INA226_ADDR, INA226_MAIN_VOLT_DIVIDER);
  }

  if (!branchADC.begin(ADS_ADDR)) {
    // Not fatal: the rig keeps shedding on the INA226 total and reports the
    // measured branches as unavailable rather than hanging. See
    // branchAdcOnline for why reading it anyway would deadlock the loop.
    Serial.printf("ADS1015 not detected at 0x%02X - check I2C SDA=%d SCL=%d, power and GND\n",
                  ADS_ADDR, I2C_SDA_PIN, I2C_SCL_PIN);
    branchAdcOnline = false;
  } else {
    branchADC.setGain(ADS_GAIN);
    branchADC.setDataRate(ADS_DATA_RATE);
    branchAdcOnline = true;
    Serial.printf("ADS1015 online at 0x%02X (%d CT channels wired)\n", ADS_ADDR, BRANCH_CT_COUNT);

    // Sampling engine on core 0. A full four-channel pass is ~730 ms, so
    // running it here would stall serial, the config poll and telemetry.
    xTaskCreatePinnedToCore(sensorTask, "SensorEngine", SENSOR_TASK_STACK,
                            NULL, SENSOR_TASK_PRIORITY, NULL, 0);
  }
#endif

  WiFi.mode(WIFI_STA);
  loadWifiSlots();

  // Try last-working network first, then the rest.
  bool linked = tryJoin(wifiSsid[wifiLastOk], wifiPass[wifiLastOk]);
  for (int k = 0; !linked && k < WIFI_SLOTS; k++) {
    int i = (wifiLastOk + k) % WIFI_SLOTS;
    if (i == wifiLastOk) continue;
    if (tryJoin(wifiSsid[i], wifiPass[i])) {
      wifiLastOk = i;
      saveWifiSlots();
      linked = true;
    }
  }
  if (!linked) {
    Serial.println("wifi: scan start");
    int scanN = WiFi.scanNetworks();
    Serial.printf("wifi: scan found %d networks\n", scanN);
    for (int i = 0; i < scanN; i++) {
      Serial.printf("wifi: visible \"%s\" RSSI=%d ch=%d\n",
                    WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
    }
    Serial.println("Wi-Fi failed; running local-only until reset");
    return;
  }
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  syncConfig();
  applyRelays();
}

void loop() {
  unsigned long now = millis();

  readMeters();
  for (int i = 0; i < OUTLET_COUNT; i++) handleManualSwitch(i);

  // Decide only on fresh data: a stale total would keep shedding channels that
  // were already cut but whose old power is still in the sum.
  if (newSample) {
    evaluateLocalPolicies();
    newSample = false;
  }
  applyRelays();

  if (WiFi.status() == WL_CONNECTED) {
    if (now - lastConfigAt > CONFIG_INTERVAL_MS) {
      lastConfigAt = now;
      if (syncConfig()) applyRelays();
    }
    if (now - lastTelemetryAt > TELEMETRY_INTERVAL_MS) {
      lastTelemetryAt = now;
#if TELEMETRY_ENABLED
      postTelemetry();
#endif
    }
  }

  if (now - lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
    lastSnapshotAt = now;
    printChannelSnapshot();
  }

#ifdef LED_BUILTIN
  digitalWrite(LED_BUILTIN, (now / 500) % 2 ? HIGH : LOW);
#endif

  delay(200);
}