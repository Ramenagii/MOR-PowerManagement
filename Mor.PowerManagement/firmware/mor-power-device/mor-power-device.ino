// MOR power-management prototype — ESP32-S3 edge controller.
//
// Each loop iteration the firmware:
//   1. reads ONE mains meter and estimates per-channel watts from that total,
//      weighted by each channel's allowance,
//   2. evaluates the ECA policy table locally (POL-01..POL-08 twins),
//   3. drives thirteen relay channels (8x220V + 1x110V + 4xUSB),
//   4. POSTs telemetry to the backend and periodically re-syncs config.
//
// Meter front end is selected by METER_SOURCE in config.h:
//   METER_SIMULATE  synthesised, no hardware (the current default)
//   METER_ZMPT101B  expansion board, isolated V+I pair on ADC1
//   METER_PZEM004T  PZEM-004T v3.0 over UART
// All three feed the same downstream path, so swapping in the PZEM later is a
// one-constant change and not a rewrite.
//
// The backend (ASP.NET Core + Neon) is the system of record. Policy edits made
// in the dashboard reach the hardware through GET /api/Device/config, which the
// firmware polls every CONFIG_INTERVAL_MS and writes to NVS; the ESP32 keeps
// running the last synced policy table when the network drops.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>
#include <Preferences.h>

// config.h must precede any conditional include below: it defines
// METER_SOURCE, and an undefined macro evaluates to 0 in #if, so testing it
// before the header is present silently selects the wrong branch.
#include "config.h"

#if METER_SOURCE == METER_ZMCT103C
#include <Wire.h>
#endif

// Desired-state codes from GET /api/Device/config (OutletStatus enum order).
#define DESIRED_ACTIVE 0
#define DESIRED_STANDBY 1

// Single mains meter for the 13-channel rig (common feed, address 1).
// Per-channel power is estimated from the mains total weighted by allowance.
PZEM004Tv30 mainsMeter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN, 0x01);

// Latest raw mains reading, whichever front end produced it.
// A value of -1 means "this meter did not produce a reading", which the policy
// layer treats as a sensor fault rather than as a zero-load measurement.
struct MainsReading {
  float volts = -1.0f;
  float amps = -1.0f;
  float watts = -1.0f;
};

#if METER_SOURCE == METER_ZMPT101B

/**
 * RMS from a ZMPT101B OUT pin.
 *
 * The output is a small AC waveform riding on roughly 1.5 V of DC bias, so the
 * ADC reading against ground is meaningless as an AC measurement. The correct
 * method is to sample a window, take the peak-to-peak excursion, halve it for
 * the peak amplitude, and multiply by 1/sqrt(2) for RMS:
 *
 *     Vrms = (pp / 2) * (Vref / full_scale) * 0.7071 * calibration
 *
 * `ok` is false when the excursion is below the noise floor, which is how an
 * unconnected or de-energised sensor presents itself. Reporting that as 0.0 A
 * would be indistinguishable from a real zero-load reading.
 */
bool zmptRms(uint8_t pin, float calibration, float &rms, uint16_t &peakToPeak) {
  int lo = 4095;
  int hi = 0;

  for (int i = 0; i < ZMPT_SAMPLE_COUNT; i++) {
    int raw = analogRead(pin);
    if (raw < lo) lo = raw;
    if (raw > hi) hi = raw;
  }

  peakToPeak = (uint16_t)(hi - lo);
  if (peakToPeak < ZMPT_NOISE_FLOOR) {
    rms = 0.0f;
    return false;
  }

  const float vref = 3.3f;
  const float fullScale = 4095.0f;
  const float peak = (peakToPeak / 2.0f) * (vref / fullScale);
  rms = peak * 0.70710678f * calibration;
  return true;
}

#endif  // METER_SOURCE == METER_ZMPT101B

#if METER_SOURCE == METER_ZMCT103C
// ---------------------------------------------------------------------------
// Runtime-adjustable calibration.
//
// These are the four numbers that describe the hardware you actually fitted.
// They arrive from the backend on every config sync and are cached in NVS, so
// a re-trim is a dashboard edit rather than a reflash. That matters because
// the CT ratio in particular is frequently mislabelled on the part, and a wrong
// ratio scales every reading by a constant factor.
// ---------------------------------------------------------------------------
float zmctCtRatio = ZMCT_DEFAULT_CT_RATIO;
float zmctBurdenOhms = ZMCT_DEFAULT_BURDEN_OHMS;
float zmctPowerFactor = ZMCT_DEFAULT_POWER_FACTOR;
float zmctGain = ZMCT_DEFAULT_GAIN;

// Last window's diagnostics, published in the serial snapshot so a bench
// session can be debugged without a logic analyser.
float zmctLastVoltsRms = 0;
uint16_t zmctLastPp = 0;
uint16_t zmctLastBias = 0;
bool zmctFrontEndOk = false;
bool zmctAdcOnline = false;

// PGA full-scale in millivolts, used to convert raw counts back to volts.
float adsFullScaleMv() {
  switch (ADS_PGA_4V096) {
    case 0b000: return 6.144f;   // +/-4.096 V
    case 0b001: return 4.096f;   // +/-2.048 V
    case 0b010: return 2.048f;   // +/-1.024 V
    case 0b011: return 1.024f;   // +/-0.512 V
    case 0b100: return 0.512f;   // +/-0.256 V
    case 0b101: return 0.256f;   // +/-0.128 V
    default:    return 4.096f;
  }
}

/**
 * Single-shot read of the ADS front end.
 *
 * Written against the TI register map rather than pulling in a library: the
 * project has no ADS1xxx dependency installed, and the subset needed here is
 * three register writes and one read. Config register is rebuilt from scratch
 * every conversion rather than read-modify-written, so a partially written
 * config on a brown-out cannot leave the PGA or MUX in an unknown state.
 */
bool adsReadMilliVolts(float &mv) {
  // CONFIG (0x01): OS=1 start a single conversion, MUX, PGA, MODE=1, SPS.
  const uint16_t cfg = (uint16_t)(0x8000 | (ADS_MUX_AIN0_GND << 12) |
                                  (ADS_PGA_4V096 << 9) | 0x0200 | (ADS_SPS_128 << 5));
  Wire.beginTransmission(ADS_I2C_ADDR);
  Wire.write(0x01);
  Wire.write((uint8_t)(cfg >> 8));
  Wire.write((uint8_t)(cfg & 0xFF));
  if (Wire.endTransmission() != 0) return false;

  // A conversion at 128 SPS takes ~7.8 ms. Waiting properly matters: polling
  // the conversion register too early returns a stale or mid-conversion value,
  // which shows up as a plausible-looking but wrong bias.
  delay(10);

  Wire.beginTransmission(ADS_I2C_ADDR);
  Wire.write(0x00);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)ADS_I2C_ADDR, (int)2) != 2) return false;

  const int16_t raw = (int16_t)(((uint16_t)Wire.read() << 8) | Wire.read());

#if ADS_IS_1115
  mv = (float)raw * (adsFullScaleMv() / 32768.0f);
#else
  mv = (float)raw * (adsFullScaleMv() / 2048.0f);
#endif
  return true;
}

/**
 * Read primary current from the ZMCT103C via the ADS1015 front end.
 *
 * The CT produces a bipolar AC waveform centred on the 1.65 V bias. RMS must
 * come from the peak-to-peak excursion, never the absolute value -- reading the
 * pin against ground reports the bias as ~1.65 V of DC and is meaningless.
 *
 * Returns false when the front end is not believable. A genuine "no load" is
 * NOT a failure: it returns true with 0 A, because an empty CT sitting at its
 * bias is a legitimate reading and must still be published.
 */
bool zmctReadAmps(float &amps, float &voltsRms) {
  int lo = 0x7FFF, hi = -0x7FFF;
  double sum = 0;
  uint32_t valid = 0;

  for (int i = 0; i < ZMCT_SAMPLE_COUNT; i++) {
    float mv;
    if (!adsReadMilliVolts(mv)) continue;
    int v = (int)lroundf(mv);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += mv;
    valid++;
  }

  // No successful I2C transaction at all means the ADC is absent or the bus is
  // wrong. Distinguished from a bad bias, because the remedies differ.
  if (valid == 0) {
    zmctAdcOnline = false;
    zmctFrontEndOk = false;
    zmctLastPp = 0;
    zmctLastBias = 0;
    zmctLastVoltsRms = 0;
    amps = 0.0f;
    voltsRms = 0.0f;
    return false;
  }
  zmctAdcOnline = true;

  const uint16_t pp = (uint16_t)(hi - lo);
  const float biasMv = (float)(sum / valid);
  const uint16_t biasCounts = (uint16_t)(biasMv * 1000.0f);

  zmctLastPp = pp;
  zmctLastBias = biasCounts;
  zmctLastVoltsRms = 0;  // stays 0 on the failure / no-load paths below

  // Expected bias is half of full scale: ~2048 mV at +/-4.096 V.
  zmctFrontEndOk = fabsf(biasMv - (adsFullScaleMv() / 2.0f)) <= 400.0f;
  if (!zmctFrontEndOk) {
    amps = 0.0f;
    voltsRms = 0.0f;
    return false;
  }

  if (pp < 40) {   // ~40 mV p-p of noise floor, in millivolts
    amps = 0.0f;   // CT is carrying no current: legitimate, not a fault
    voltsRms = 0.0f;
    return true;
  }

  // Peak-to-peak -> peak -> RMS. The CT waveform is sinusoidal, so the
  // 1/sqrt(2) form factor applies; the 2 on peak-to-peak is the half-wave
  // amplitude.
  const float peak = (pp / 2.0f);
  voltsRms = peak * 0.70710678f * zmctGain;

  // Secondary RMS current through the burden, stepped back up by the ratio.
  const float secondaryAmps = (voltsRms / 1000.0f) / zmctBurdenOhms;
  amps = secondaryAmps * zmctCtRatio;
  return true;
}
#endif  // METER_SOURCE == METER_ZMCT103C

struct ChannelState {
  float voltage = 0;
  float current = 0;
  float power = 0;
  float energy = 0;
  bool relayClosed = false;
  bool localShed = false;
  uint8_t faultStreak = 0;
  bool switchLast = HIGH;
  unsigned long switchChangedAt = 0;
};

ChannelState channels[OUTLET_COUNT];

// Synced policy table (backend is the authority).
// Defaults match the 13-channel rig: 8x500W + 300W + 4x10W, P_limit 3600W.
// CH10-13 are USB-A 5V/2.1A ports, so 10W is the honest ceiling per port
// (5V x 2.1A). A larger allowance would authorise a load the port cannot serve.
float cfgLimit = 3600;        // P_limit
float cfgWarning = 3240;
float cfgStandby = 80;
int cfgStabilizationMs = 500;
int prioRank[OUTLET_COUNT] = { 0, 1, 1, 2, 2, 3, 3, 3, 2, 3, 3, 3, 3 };
float allowanceW[OUTLET_COUNT] = { 500, 500, 500, 500, 500, 500, 500, 500, 300, 10, 10, 10, 10 };
// Nominal volts at each channel's own output. CH1-8 sit on the mains bus and
// match the PZEM reading; CH9 is fed by the step-down transformer and CH10-13
// by the 5V buck rail, so reporting the mains reading for those would be wrong.
float ratedVolts[OUTLET_COUNT] = { 220, 220, 220, 220, 220, 220, 220, 220, 110, 5, 5, 5, 5 };
bool desiredEnergized[OUTLET_COUNT] = { false, false, false, false, false, false, false, false, false, false, false, false, false };
bool configSynced = false;

// On-device copy of the policy table (NVS flash). The protection logic runs
// from this copy, so the prototype enforces the last synced policy even with
// no network, and resumes it immediately on power-up.
Preferences nvsPolicy;
const uint32_t POLICY_MAGIC = 0x4D4F5232;  // "MOR2": 16-bit desired mask for 13 channels
unsigned long missedPosts = 0;

bool sFault = false;
// Peak-to-peak excursion from the last ZMPT101B window, kept for the serial
// snapshot so a dead sensor is visible as a number rather than inferred from a
// suspicious 0.0 A reading.
uint16_t lastZmptPp = 0;
uint16_t lastZmptAp = 0;
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
    digitalWrite(RELAY_PINS[i], closed ? RELAY_CLOSED_LEVEL : !RELAY_CLOSED_LEVEL);
  }
}

float totalLoad() {
  float total = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) total += channels[i].power;
  return total;
}

void readMeters() {
#if SIMULATE_METERS
  // Placeholder: no PZEM wired. Synthesize a plausible mains load from the
  // energized channels so the full telemetry -> dashboard loop can be tested.
  static float simEnergy = 0;
  float simDenom = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (channels[i].relayClosed || desiredEnergized[i]) simDenom += allowanceW[i];
  }
  float simTotal = simDenom * 0.72;  // mirrors the backend activation estimate
  simEnergy += simTotal * (200.0f / 3600000.0f);  // ~200ms loop slice
  for (int i = 0; i < OUTLET_COUNT; i++) {
    channels[i].voltage = ratedVolts[i];
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].power = simDenom > 0 ? simTotal * (allowanceW[i] / simDenom) : 0;
      channels[i].current = channels[i].voltage > 0 ? channels[i].power / channels[i].voltage : 0;
    } else {
      channels[i].current = 0;
      channels[i].power = 0;
    }
    channels[i].energy = simEnergy;
  }
  channels[0].faultStreak = 0;
  return;
#endif
  float v;
  float p;
  float e;
#if METER_SOURCE == METER_ZMPT101B
  // ZMPT101B expansion board: one isolated voltage pair and one current pair on
  // the common mains feed. Peak-to-peak over a sampling window gives RMS, so the
  // DC bias the module sits at is removed by construction.
  float vRms, aRms;
  uint16_t vpp, app;
  bool vOk = zmptRms(ZMPT_VOLT_PIN, ZMPT_VOLT_CAL, vRms, vpp);
  bool aOk = zmptRms(ZMPT_CURR_PIN, ZMPT_CURR_CAL, aRms, app);

  // A silent current channel means no load, which is legitimate. A silent
  // voltage channel means the sensor is not reporting at all, which is a fault.
  if (!vOk) {
    channels[0].faultStreak++;
    if (channels[0].faultStreak >= FAULT_TRIP_COUNT && !sFault) {
      sFault = true;
      Serial.println("POL-01: S_fault TRUE (ZMPT101B voltage channel silent), all relays opened");
    }
    return;
  }

  channels[0].faultStreak = 0;
  v = vRms;
  p = aOk ? vRms * aRms : 0.0f;
  e = mainsMeter.energy();  // PZEM stays as the energy counter until it is replaced
  lastZmptPp = vpp;
  lastZmptAp = app;
#elif METER_SOURCE == METER_ZMCT103C
  // ZMCT103C on the common feed: CURRENT ONLY.
  //
  // A current transformer has no voltage output, so `v` is deliberately NOT a
  // measurement. It stays at the nominal mains rating and is used only to turn
  // the measured amps into estimated watts. Reporting a fabricated voltage as
  // though it were measured is the specific dishonesty this branch avoids.
  float aRms, senseRms;
  bool aOk = zmctReadAmps(aRms, senseRms);

  if (!aOk) {
    // Front end not believable (bias off mid-supply, divider missing, cap open
    // or buffer unpowered). Publishing the resulting amps would be worse than
    // reporting nothing, so treat it as POL-01 hardware isolation.
    channels[0].faultStreak++;
    if (channels[0].faultStreak >= FAULT_TRIP_COUNT && !sFault) {
      sFault = true;
      Serial.printf("POL-01: S_fault TRUE (ZMCT103C front end implausible, bias=%u counts)\n",
                    zmctLastBias);
    }
    return;
  }

  channels[0].faultStreak = 0;
  // Reuse the configured nominal for the mains bus rather than inventing a
  // constant, so Policy Admin stays the single source of truth for rail volts.
  v = ratedVolts[0] > 0 ? ratedVolts[0] : 220.0f;   // nominal rail, NOT measured
  p = v * aRms * ZMCT_POWER_FACTOR;                 // ESTIMATED watts
  e = mainsMeter.energy();                // no energy counter on a CT
  if (isnan(p) || p < 0) p = 0;
#else
  v = mainsMeter.voltage();
  p = mainsMeter.power();
  e = mainsMeter.energy();

  // Current is no longer sampled: per-channel amps are derived from each
  // channel's own volts, so only the values actually consumed are validated.
  if (isnan(v) || isnan(p)) {
    // POL-01 hardware fault isolation (single mains meter unreadable).
    channels[0].faultStreak++;
    if (channels[0].faultStreak >= FAULT_TRIP_COUNT && !sFault) {
      sFault = true;
      Serial.println("POL-01: S_fault TRUE (mains meter unreadable), all relays opened");
    }
    return;
  }
#endif

  channels[0].faultStreak = 0;

  // Distribute the mains total across energized channels weighted by allowance.
  // Current is then derived per channel from its own volts, so the step-down
  // (CH9, 110V) and the buck rail (CH10-13, 5V) report amps consistent with
  // the power they are carrying instead of a scaled mains current.
  float denom = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (channels[i].relayClosed || desiredEnergized[i]) denom += allowanceW[i];
  }
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (ratedVolts[i] > 0 && fabsf(ratedVolts[i] - 220.0f) < 1.0f) {
      channels[i].voltage = v;  // mains-bus channels report the measured value
    } else {
      channels[i].voltage = ratedVolts[i];  // derived rails report nominal
    }
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].power = denom > 0 ? p * (allowanceW[i] / denom) : 0;
      channels[i].current = channels[i].voltage > 0 ? channels[i].power / channels[i].voltage : 0;
    } else {
      channels[i].current = 0;
      channels[i].power = 0;
    }
    if (!isnan(e)) channels[i].energy = e;
  }
}

// POL-05: lowest priority rank first, ties broken by higher draw.
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

// Per-channel idle timer for POL-08. `idleSinceMs[i]` is the millis() value at
// which the channel was first observed at or below the standby threshold; 0
// means "not currently idle". A per-channel limit overrides the global
// StandbyIdleMinutes; -1 means the channel is exempt.
int idleLimitMinutes[OUTLET_COUNT] = { -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1 };
unsigned long idleSinceMs[OUTLET_COUNT] = { 0 };
int cfgStandbyIdleMinutes = 30;

/**
 * POL-08 standby load management.
 *
 * A channel that is energized but drawing at or below the standby threshold is
 * "idle". After its idle limit elapses the relay is opened.
 *
 * Why this runs on the device rather than only on the server: the policy table
 * is the firmware's contract with the backend, and POL-08 is the only rule in
 * POL-01..POL-08 that had no local implementation at all -- cfgStandby was
 * fetched and persisted but never evaluated. Server-side,
 * LoadResponseEvaluator.DetectIdleCandidates exists but had no callers, so the
 * rule was enforced nowhere. The ESP32 is also the component that can act
 * without a network round-trip, which is what the "runs the last synced policy
 * when the network drops" property requires.
 */
void enforceStandbyPolicy(unsigned long now) {
  for (int i = 0; i < OUTLET_COUNT; i++) {
    // Only energized channels can be idle-but-connected.
    if (!channels[i].relayClosed) {
      idleSinceMs[i] = 0;
      continue;
    }

    // A fault lockout opens relays itself; do not second-guess it here.
    if (sFault || channels[i].localShed) continue;

    if (channels[i].power > cfgStandby) {
      idleSinceMs[i] = 0;  // back above the threshold: restart the timer
      continue;
    }

    const int limit = idleLimitMinutes[i] >= 0 ? idleLimitMinutes[i] : cfgStandbyIdleMinutes;
    if (limit <= 0) continue;  // 0 disables the timer for this channel

    if (idleSinceMs[i] == 0) {
      idleSinceMs[i] = now;  // first sample below threshold starts the clock
      continue;
    }

    const unsigned long elapsed = now - idleSinceMs[i];
    if (elapsed >= (unsigned long)limit * 60UL * 1000UL) {
      channels[i].relayClosed = false;
      idleSinceMs[i] = 0;
      Serial.printf("POL-08: channel %d idle at %.0f W for %d min, standby shed\n",
                    i + 1, channels[i].power, limit);
    }
  }
}

void evaluateLocalPolicies() {
  if (sFault) return;

  float total = totalLoad();

  if (LOCAL_AUTO_SHED && total > cfgLimit) {
    int pick = pickShedCandidate();
    if (pick >= 0) {
      channels[pick].localShed = true;
      Serial.printf("POL-05: P_total %.0f W > P_limit %.0f W, shed channel %d\n",
                    total, cfgLimit, pick + 1);
    }
  }

  // Release local sheds once headroom is back.
  if (total <= cfgWarning) {
    for (int i = 0; i < OUTLET_COUNT; i++) channels[i].localShed = false;
  }

  // POL-08 runs after the capacity rules: a shed for overload is not an idle
  // shed, and applying both to one channel would report the wrong reason.
  enforceStandbyPolicy(millis());
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
      // POL-02 / POL-03 pre-activation assessment.
      float projected = totalLoad() + allowanceW[i];
      if (projected > cfgLimit) {
        Serial.printf("POL-03: channel %d request denied (%.0f W + %.0f W > %.0f W)\n",
                      i + 1, totalLoad(), allowanceW[i], cfgLimit);
        return;
      }
      Serial.printf("POL-02: channel %d allowed, closing relay\n", i + 1);
      desiredEnergized[i] = true;
      applyRelays();
      delay(cfgStabilizationMs);
      readMeters();
      // POL-04 post-activation verification.
      if (totalLoad() > cfgLimit) {
        channels[i].localShed = true;
        Serial.printf("POL-04: channel %d verification failed, shed\n", i + 1);
      }
      applyRelays();
    }
  }
}

void savePolicyTable() {
  nvsPolicy.begin("mor", false);
  nvsPolicy.putUInt("magic", POLICY_MAGIC);
  nvsPolicy.putFloat("limit", cfgLimit);
  nvsPolicy.putFloat("warn", cfgWarning);
  nvsPolicy.putFloat("standby", cfgStandby);
  nvsPolicy.putInt("stabMs", cfgStabilizationMs);
  // POL-08 inputs. Persisted so the standby rule survives a reboot with no
  // network: a device that forgot its idle duration would either shed channels
  // immediately or never shed them at all.
  nvsPolicy.putInt("sbIdle", cfgStandbyIdleMinutes);
#if METER_SOURCE == METER_ZMCT103C
  nvsPolicy.putFloat("zmRatio", zmctCtRatio);
  nvsPolicy.putFloat("zmBurden", zmctBurdenOhms);
  nvsPolicy.putFloat("zmPF", zmctPowerFactor);
  nvsPolicy.putFloat("zmGain", zmctGain);
#endif
  {
    int16_t idleArr[OUTLET_COUNT];
    for (int i = 0; i < OUTLET_COUNT; i++) idleArr[i] = (int16_t)idleLimitMinutes[i];
    nvsPolicy.putBytes("idleLim", idleArr, sizeof(idleArr));
  }
  uint8_t prio[OUTLET_COUNT];
  for (int i = 0; i < OUTLET_COUNT; i++) prio[i] = (uint8_t)prioRank[i];
  nvsPolicy.putBytes("prio", prio, OUTLET_COUNT);
  nvsPolicy.putBytes("allow", allowanceW, sizeof(allowanceW));
  nvsPolicy.putBytes("volts", ratedVolts, sizeof(ratedVolts));
  uint16_t mask = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (desiredEnergized[i]) mask |= (uint16_t)(1u << i);
  }
  nvsPolicy.putUShort("desired", mask);
  nvsPolicy.end();
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
  cfgStandbyIdleMinutes = nvsPolicy.getInt("sbIdle", cfgStandbyIdleMinutes);
#if METER_SOURCE == METER_ZMCT103C
  // Absent in tables written before calibration became runtime-adjustable; the
  // compiled defaults then stand, which is the safe direction.
  zmctCtRatio = nvsPolicy.getFloat("zmRatio", zmctCtRatio);
  zmctBurdenOhms = nvsPolicy.getFloat("zmBurden", zmctBurdenOhms);
  zmctPowerFactor = nvsPolicy.getFloat("zmPF", zmctPowerFactor);
  zmctGain = nvsPolicy.getFloat("zmGain", zmctGain);
#endif
  // Absent in tables written before POL-08 was implemented; leaving the
  // compiled -1 (exempt) defaults in place is the safe direction, since an
  // un-enforced standby rule only wastes power while a wrongly-enforced one
  // would shed channels the operator had deliberately exempted.
  {
    int16_t idleArr[OUTLET_COUNT];
    if (nvsPolicy.getBytes("idleLim", idleArr, sizeof(idleArr)) == sizeof(idleArr)) {
      for (int i = 0; i < OUTLET_COUNT; i++) idleLimitMinutes[i] = idleArr[i];
    }
  }
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
  // POL-08 idle duration. Without this the local standby rule had no timer to
  // run on and would have had to fall back to a compiled-in guess.
  cfgStandbyIdleMinutes = doc["standbyIdleMinutes"] | cfgStandbyIdleMinutes;

#if METER_SOURCE == METER_ZMCT103C
  // Runtime-adjustable sensor calibration. The backend is the source of truth
  // because these describe the hardware actually fitted, not the firmware build.
  // Guarded on positivity so a malformed or zero value cannot silently scale
  // every reading to zero -- a null-overwrite bug would look like "no load".
  float r = doc["zmctCtRatio"] | zmctCtRatio;
  float b = doc["zmctBurdenOhms"] | zmctBurdenOhms;
  float pf = doc["zmctPowerFactor"] | zmctPowerFactor;
  float g = doc["zmctGain"] | zmctGain;
  if (r > 0) zmctCtRatio = r;
  if (b > 0) zmctBurdenOhms = b;
  if (pf > 0 && pf <= 1.0) zmctPowerFactor = pf;
  if (g > 0) zmctGain = g;
#endif

  JsonArray outlets = doc["outlets"];
  for (JsonObject o : outlets) {
    int ch = (int)o["channelId"] - 1;
    if (ch < 0 || ch >= OUTLET_COUNT) continue;
    prioRank[ch] = o["priority"] | 1;
    allowanceW[ch] = o["allowanceWatts"] | 0.0f;
    ratedVolts[ch] = o["ratedVoltageVolts"] | ratedVolts[ch];
    // idleLimitMinutes is nullable: null means the channel is EXEMPT from the
    // POL-08 standby shutdown, which is why -1 is the exempt marker rather than
    // 0. Reading it as 0 would silently exempt or enforce the wrong channels.
    if (o["idleLimitMinutes"].isNull()) {
      idleLimitMinutes[ch] = -1;
    } else {
      idleLimitMinutes[ch] = o["idleLimitMinutes"] | -1;
    }
    int desired = o["desiredStatus"] | 3;
    desiredEnergized[ch] = (desired == DESIRED_ACTIVE || desired == DESIRED_STANDBY);
  }

  configSynced = true;
  Serial.printf("config synced: P_limit=%.0f W, %d channels\n", cfgLimit, outlets.size());
  savePolicyTable();
  Serial.println("policy table stored to flash");
  return true;
}

bool postTelemetry() {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["faultFlag"] = sFault;
  doc["missedPosts"] = missedPosts;

#ifdef REPORT_METERING_MODE
  // Provenance for the values in this batch:
  //   1 = Simulated        - synthesised on the ESP32 (SIMULATE_METERS)
  //   2 = Metered          - a real PZEM-004T measures V, I and energy
  //   3 = EstimatedFromCurrent - ZMCT103C CT: current measured, volts nominal,
  //                         watts estimated at an assumed power factor
  // The backend renders these differently, so posting 2 from a CT build would
  // make the UI claim measured volts and watts that were never measured.
#if SIMULATE_METERS
  doc["meteringMode"] = 1;
#elif METER_SOURCE == METER_ZMCT103C
  doc["meteringMode"] = 3;
#else
  doc["meteringMode"] = 2;
#endif
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

// Per-channel snapshot: C = relay closed, o = relay open.
// CH1-8 = 220V outlets, CH9 = 110V outlet, CH10-13 = USB sockets.
// Volts is the channel's own rail, not the mains bus reading: CH9 shows 110V
// and CH10-13 show 5V, so a mis-rated channel is visible without a meter.
// Driven from loop() rather than postTelemetry() so the bench stays
// observable when the backend is unreachable - a device that only reports
// while online is unverifiable exactly when something has gone wrong.
void printChannelSnapshot() {
  Serial.print("channels:");
  for (int i = 0; i < OUTLET_COUNT; i++) {
    Serial.printf(" %d:%s%.0fW/%.0fV", i + 1, channels[i].relayClosed ? "C" : "o",
                  channels[i].power, channels[i].voltage);
  }
  Serial.println();
#if METER_SOURCE == METER_ZMPT101B
  // Publishing the raw excursion alongside the derived RMS is what makes a
  // dead sensor diagnosable: pp near zero with 0 A is a wiring problem, not a
  // quiet channel.
  Serial.printf("zmpt: v_pp=%u i_pp=%u%s\n", lastZmptPp, lastZmptAp,
                sFault ? " FAULT" : "");
#endif
#if METER_SOURCE == METER_ZMCT103C
  // bias is the single most useful number while commissioning: ~2048 mV means
  // the front end is alive, ~0 or ~4096 means it is not wired. pp then confirms
  // the CT path separately from the bias network. adc=0 means the I2C device
  // did not answer at all -- a different fault with a different fix.
  Serial.printf("zmct: adc=%s bias=%umV/%d pp=%umV v_rms=%.3fV %s\n",
                zmctAdcOnline ? "ok" : "MISSING", zmctLastBias,
                (int)adsFullScaleMv() / 2, zmctLastPp, zmctLastVoltsRms,
                zmctFrontEndOk ? "" : "FRONT-END-IMPLAUSIBLE");
  Serial.printf("zmct cal: ratio=%.0f burden=%.1fR pf=%.2f gain=%.3f\n",
                zmctCtRatio, zmctBurdenOhms, zmctPowerFactor, zmctGain);
#endif
}

void setup() {
  Serial.begin(115200);

  for (int i = 0; i < OUTLET_COUNT; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], !RELAY_CLOSED_LEVEL);  // fail-safe: open
    if (SWITCH_PINS[i] != 0) pinMode(SWITCH_PINS[i], INPUT_PULLUP);
  }
#ifdef LED_BUILTIN
  pinMode(LED_BUILTIN, OUTPUT);
#endif

  Serial.println("\nMOR power-management prototype starting");
#if METER_SOURCE == METER_ZMPT101B
  // 12-bit samples on ADC1. ADC1 is used deliberately: ADC2 is driven by the
  // Wi-Fi radio on this chip and cannot be read while associated.
  analogReadResolution(12);
  analogSetPinAttenuation(ZMPT_VOLT_PIN, ADC_11db);
  analogSetPinAttenuation(ZMPT_CURR_PIN, ADC_11db);
  Serial.printf("meter: ZMPT101B on ADC1 (V=GPIO%d, I=GPIO%d)\n", ZMPT_VOLT_PIN, ZMPT_CURR_PIN);
#elif METER_SOURCE == METER_ZMCT103C
  // The CT is read through an external ADS1015/ADS1115 on I2C, not the S3's
  // internal ADC. Wire.begin() must succeed before any sample loop runs, or
  // every read fails and the front-end check trips with no diagnosis.
  Wire.begin(ADS_SDA_PIN, ADS_SCL_PIN, 400000);
  Wire.setTimeOut(50);
  Serial.printf("meter: ZMCT103C via ADS1115 on I2C (SDA=GPIO%d, SCL=GPIO%d, addr=0x%02X)\n",
                ADS_SDA_PIN, ADS_SCL_PIN, ADS_I2C_ADDR);
  Serial.printf("  NOTE: current only. Volts are the nominal rail rating and watts are\n");
  Serial.printf("  ESTIMATED as V_nominal x I x %.2f. Real power needs a PZEM-004T.\n",
                zmctPowerFactor);
  Serial.println("  Front-end check: bias must sit near mid-supply (~1.65 V, 2048 mV).");
  Serial.println("  Calibration (ratio/burden/PF/gain) is pushed from the backend and cached in NVS.");
#elif METER_SOURCE == METER_PZEM004T
  Serial.printf("meter: PZEM-004T v3.0 on UART (RX=GPIO%d, TX=GPIO%d)\n", PZEM_RX_PIN, PZEM_TX_PIN);
#else
  Serial.println("SIM mode: synthetic mains readings (no sensor wired)");
#endif

  if (loadPolicyTable()) {
    Serial.printf("policy restored from flash: P_limit=%.0f W\n", cfgLimit);
  } else {
    Serial.println("no stored policy, using compiled defaults until first sync");
  }
  applyRelays();

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
  evaluateLocalPolicies();
  applyRelays();

  if (WiFi.status() == WL_CONNECTED) {
    if (now - lastConfigAt > CONFIG_INTERVAL_MS) {
      lastConfigAt = now;
      if (syncConfig()) applyRelays();
    }
    if (now - lastTelemetryAt > TELEMETRY_INTERVAL_MS) {
      lastTelemetryAt = now;
      postTelemetry();
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
