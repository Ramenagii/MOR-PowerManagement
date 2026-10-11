#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// MOR power-management prototype — ESP32 edge controller.
// Edit the values below for your bench, then compile and flash with:
//   arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
//   arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
// The board is an ESP32-S3 (WCH CH343 USB-serial). Using esp32:esp32:esp32
// compiles but esptool refuses the flash with "This chip is ESP32-S3".
// ---------------------------------------------------------------------------

// Testing rig (MUST_READ.md, until 31 Oct 2026): 4x220V outlets + 1xUSB 5V.
// Restore to 13 for the final rig: CH1-8 220V, CH9 110V, CH10-13 USB.
#define OUTLET_COUNT 5

// ---- Wi-Fi ----
// Credentials live in NVS flash (written on first setup), so the repo never
// holds a real password. The values in config.h are first-boot seeds only and
// are ignored once NVS holds a working network.
//
// config.local.h is where real credentials go, and it is git-ignored so a
// password can never reach the repository by accident. Copy
// config.local.h.example to config.local.h and fill it in.
#if __has_include("config.local.h")
#include "config.local.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif

// Saved-network store: up to WIFI_SLOTS SSID/password pairs in NVS.
#define WIFI_SLOTS 3
#define WIFI_JOIN_TIMEOUT_MS 12000UL

// ---- Backend (ASP.NET Core Web API) ----
// LAN bench: point the device at the PC running the backend. The cloud host
// still runs the full 13-channel rig and re-seeds it on every start, which
// silently overwrites the 5-channel testing configuration that MUST_READ.md
// defines for this phase. Talking to the LAN backend keeps the testing rig and
// the dashboard in the same place.
#define BACKEND_HOST "192.168.18.47"
#define BACKEND_PORT 5211
#define BACKEND_BASE "/api"
// 1 = https (host has a real cert), 0 = plain http for the LAN bench.
#define BACKEND_USE_TLS 0
#define DEVICE_ID "mor-prototype-01"
// Must match the backend Device:ApiKey when key enforcement is turned on.
#define DEVICE_API_KEY "vuZAWog0U6MnqHF58TK3DhCzO9Je2atQ"

// ---- Timing ----
// Telemetry is 1 Hz so the dashboard reads as live rather than as a slow poll.
// The device posts 5 channels per second; retention is handled server-side, and
// 15 s config sync is plenty because thresholds rarely move mid-session.
#define TELEMETRY_INTERVAL_MS 1000UL
#define CONFIG_INTERVAL_MS 15000UL
// Serial per-channel snapshot. Deliberately independent of the telemetry
// interval so the rig stays observable with no backend reachable.
#define SNAPSHOT_INTERVAL_MS 5000UL

// ---------------------------------------------------------------------------
// RAW TEST MODE (temporary — see MUST_READ.md section 11)
// The measurement chain is proven; telemetry is now posted so the readings are
// visible on the dashboard. The two protective subsystems stay OFF until the
// bench authorises them:
//   0 = relays are not driven (pins stay at POWER_ON, so channels stay live)
//   0 = framework rules do not evaluate and cannot shed or trip anything
//   1 = telemetry is posted once a second
// ---------------------------------------------------------------------------
#define RELAY_OUTPUT_ENABLED 0
#define RULES_ENABLED 0
#define TELEMETRY_ENABLED 1

// ---- I2C bus (shared by INA226 + ADS1015) ----
// Bench wiring: SDA = GPIO 8, SCL = GPIO 9. These are the pins the ADS1015 is
// physically wired to, so they are fixed by the hardware, not chosen.
#define I2C_SDA_PIN 8
#define I2C_SCL_PIN 9
// I2C bus speed. 100 kHz is what this wiring sustains RIGHT NOW: measured on
// the current hardware, a 400 kHz build found NEITHER the INA226 (0x40) nor
// the ADS1015 (0x48), while a 100 kHz build found both. The standalone sketch
// ran at 400 kHz earlier in the day, but the modules have since been unplugged
// and re-seated, and the current wiring no longer tolerates the fast rate.
// Revisit only with short leads and stronger pull-ups, verified by a bus scan.
#define I2C_CLOCK_HZ 100000

// ---- INA226: mains bus meter on the common 220 V feed ----
// Provides the authoritative V / A / W for the whole extension, replacing the
// assumed line voltage the standalone branch monitor used.
// The INA226 senses at most 36 V, so it sits behind a divider on the mains feed.
#define INA226_ADDR 0x40
// Bus-voltage divider ratio, calibrated on the bench. The INA226 reports 24.1 V
// at its bus pin; mains measured 228 V with a multimeter, so 228 / 24.1 = 9.46.
// Re-check with a multimeter after touching the resistor ladder and update this
// one number — it is the only calibration constant in the voltage path.
#define INA226_MAIN_VOLT_DIVIDER 9.46f

// Shunt calibration, exactly as the validated bench sketch sets it: 8 A full
// scale on a 10 mOhm shunt. The INA226 derives current from the shunt voltage,
// so the wrong shunt value scales EVERY current and watt reading - this was
// reporting 0 A and 0 W while the sensor itself was fine.
#define INA226_MAX_CURRENT_AMPS 8.0f
#define INA226_SHUNT_OHM 0.010f
// Used only when the INA226 is not answering at all, so the rig still reports a
// plausible voltage instead of reading 0 V on every channel.
#define FALLBACK_MAINS_VOLTS 228.0f

// ---- ADS1015: per-branch AC current via analog CT sensors ----
// Gain and data rate are the values the bench proved out. GAIN_TWOTHIRDS is
// +/-6.144 V, which brackets a 0-5 V CT module output biased at 2.5 V.
#define ADS_ADDR 0x48
#define ADS_GAIN GAIN_TWOTHIRDS
#define ADS_DATA_RATE RATE_ADS1015_3300SPS

// CT calibration, measured on this bench against a known load.
#define ZMCT_CAL_FACTOR 0.52f
// Noise floor: raw readings below this are treated as 0 A so idle channels do
// not show phantom jitter that would keep FR-10 idle detection awake.
#define ZMCT_NOISE_FLOOR_AMPS 0.010f
// Above this fraction of the low range the mid-range factor applies, which is
// what keeps a 0.264 A reading from being reported as 0.274 A.
#define ZMCT_MID_RANGE_AMPS 0.080f
#define ZMCT_MID_RANGE_FACTOR 0.264f / 0.274f
// Adaptive filter: a step larger than this snaps through untouched, so a load
// change is visible at once instead of being smoothed into staleness. Anything
// smaller is smoothed (1 - ADAPTIVE_EMA_HISTORY old, ADAPTIVE_EMA_HISTORY new).
#define ZMCT_ADAPTIVE_STEP_AMPS 0.015f
#define ZMCT_ADAPTIVE_EMA_HISTORY 0.7f
// Samples per channel per pass. 600 samples at 3300 SPS is ~182 ms, which is
// ~11 AC cycles at 60 Hz — long enough for the RMS to mean something.
#define ZMCT_DEDICATED_SAMPLES 600
// Stack for the sampling task; it is pinned to core 0 so a full four-channel
// pass cannot delay the serial output on core 1.
#define SENSOR_TASK_STACK 4096
#define SENSOR_TASK_PRIORITY 2
// How many ADS1015 channels actually have a CT wired (0..4). Only these are
// measured; any outlet beyond this is reported as derived, never as measured.
#define BRANCH_CT_COUNT 4
// Per-branch overcurrent trip in amps RMS, evaluated by FR-03 on the board.
#define BRANCH_OVERCURRENT_AMPS 5.0f

// How often the sensor sweep runs. The RMS window is blocking by nature
// (2 CT channels x ~184 ms), so it is deliberately NOT run every loop
// iteration: doing that starves the Wi-Fi and telemetry work in the same loop.
// The main loop keeps spinning at full speed between sweeps, and the dashboard
// still sees a fresh reading every second.
#define METER_INTERVAL_MS 1000UL

// Placeholder for bench tests without hardware wired:
// 0 = read the real INA226 + ADS1015 on the wired bench.
#define SIMULATE_METERS 0

// Bench diagnostic: try several I2C pin pairs at boot and report which one the
// sensors answer on. Set to 1 to run the hunt, then back to 0. It only prints;
// it does not change how the rig runs.
#define DIAG_PIN_HUNT 0

// Provenance reported to the backend with every telemetry batch (D8). The
// backend labels the dashboard charts from this instead of hardcoding a claim,
// so the UI stays honest in both bench and metered states. The value posted is
// derived from SIMULATE_METERS: 1 = Simulated, 2 = Metered (INA226 + ADS1015
// actually read on the bench).
#define REPORT_METERING_MODE

// ---- Relay outputs, one per outlet channel ----
// Testing rig order: CH1-CH4 = 220 V outlets, CH5 = USB 5 V.
// Safe ESP32-S3 GPIOs avoiding strapping (0,3,45,46), USB (19,20) and SPI flash.
// ---- Relay outputs, one per outlet channel ----
// Testing rig order: CH1-CH4 = 220 V outlets, CH5 = USB 5 V.
// Relay GPIOs start at 10 to stay clear of the I2C pair (8, 9).
static const uint8_t RELAY_PINS[OUTLET_COUNT] = { 10, 11, 12, 13, 14 };

// NC (normally closed) contact wiring, as built on the bench:
//   power PASSES while the relay coil is idle  (pin HIGH)
//   driving LOW energises the coil, the NC contact OPENS, power is CUT
// So "energised outlet" in the framework maps to the pin being HIGH, and every
// protective action (shed, trip, master cut) must drive the pin LOW to actually
// remove power. Getting this backwards would report a live outlet as cut.
#define RELAY_POWER_ON_LEVEL HIGH
#define RELAY_POWER_OFF_LEVEL LOW

// ---- Manual switch inputs, raw rocker/switch caps (0 = not wired) ----
static const uint8_t SWITCH_PINS[OUTLET_COUNT] = { 0, 0, 0, 0, 0 };

// ---- Local autonomy ----
#define LOCAL_AUTO_SHED true
#define FAULT_TRIP_COUNT 3
#define SWITCH_DEBOUNCE_MS 50
