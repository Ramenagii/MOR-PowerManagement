#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// MOR power-management prototype — ESP32 edge controller.
// Edit the values below for your bench, then compile and flash with:
//   arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
//   arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
//
// Board: ESP32-S3 rev v0.2, QFN56, 40 MHz crystal, 8 MB embedded PSRAM
// (AP_3v3), MAC 3c:0f:02:cf:80:18.
//
// The board exposes TWO USB paths and Windows assigns them different ports:
//   COM10 - CH343 USB-UART bridge (VID_1A86&PID_55D3). UART0, works with any
//           firmware, and is what the Serial Monitor should use.
//   COM11 - chip-native USB / USB-Serial-JTAG (VID_303A&PID_1001). Disappears
//           from Windows whenever the USB peripheral is powered down, which an
//           esptool "Hard resetting via RTS pin" reliably triggers. If the port
//           vanishes mid-session, unplug and replug the cable to get it back.
// Detect with `arduino-cli board list` before each upload; do not trust a
// hardcoded port. On CH343 the chip auto-resets into the bootloader, so no BOOT
// press is needed.
//
//  * Do NOT use the esp32:esp32:esp32 FQBN. It compiles, but esptool then
//    refuses the flash with "This chip is ESP32-S3".
//
// NOTE: the build does not currently enable the 8 MB PSRAM (the stock esp32s3
// profile reports a 327,680-byte heap). Nothing here needs it yet; enable a
// PSRAM board option before allocating large buffers on the heap.
// ---------------------------------------------------------------------------

#define OUTLET_COUNT 13

// ---- Wi-Fi ----
// Credentials are stored in NVS flash (written on first setup via
// WIFI_SLOTS), so the repo never has to hold a real password. The values below
// are first-boot SEEDS ONLY: if a matching SSID is already saved in NVS, the
// stored password wins and these are ignored.
//
// WIFI_PASS is deliberately left empty so no secret is committed. Fill it in
// locally before the first flash, or provision it on-device at first boot.
//
// LOCAL SECRET: the bench password is filled in locally and this file is left
// UNCOMMITTED on purpose. Do not `git add config.h` with the password in it --
// see the note in .git/info/exclude. Strip the value back to "" before any
// commit or push.
#define WIFI_SSID "GHHK715A-2.4"
#define WIFI_PASS ""

// Saved-network store: up to WIFI_SLOTS SSID/password pairs in NVS.
#define WIFI_SLOTS 3
#define WIFI_JOIN_TIMEOUT_MS 12000UL

// ---- Backend (ASP.NET Core Web API) ----
// Cloud deployment (public, any-device access).
#define BACKEND_HOST "mor-powermanagement.onrender.com"
#define BACKEND_PORT 443
#define BACKEND_BASE "/api"
// 1 = https (host has a real cert), 0 = plain http for the LAN bench.
#define BACKEND_USE_TLS 1
#define DEVICE_ID "mor-prototype-01"
// Must match the backend Device:ApiKey when key enforcement is turned on.
#define DEVICE_API_KEY "vuZAWog0U6MnqHF58TK3DhCzO9Je2atQ"

// ---- Timing ----
#define TELEMETRY_INTERVAL_MS 5000UL
#define CONFIG_INTERVAL_MS 15000UL
// Serial per-channel snapshot. Deliberately independent of the telemetry
// interval so the rig stays observable with no backend reachable.
#define SNAPSHOT_INTERVAL_MS 5000UL

// ---- Meter source ---------------------------------------------------------
// Which front end the mains reading comes from. The dashboard's provenance
// badge is derived from SIMULATE_METERS below, never from this choice, so the
// two must stay consistent.
//
//   METER_SIMULATE  0 - no hardware. Synthesised load. Reports Simulated.
//   METER_ZMPT101B  1 - ZMPT101B current/voltage sensor pair on ADC1.
//                     Reports Metered (the value is isolated-CT measured).
//   METER_PZEM004T  2 - PZEM-004T v3.0 over UART (Modbus address 1).
//                     Reports Metered.
//
// The rig is designed around ONE meter on the common mains feed; per-channel
// power is an allowance-weighted share of that total. A later PZEM swap needs
// no code change beyond this constant.
#define METER_SIMULATE 0
#define METER_ZMPT101B 1
#define METER_PZEM004T 2

#ifndef METER_SOURCE
#define METER_SOURCE METER_SIMULATE
#endif

// Placeholder for bench tests without hardware wired:
// 1 = synthesise the mains reading (no sensor needed), 0 = read real hardware.
#define SIMULATE_METERS (METER_SOURCE == METER_SIMULATE)

// ---- ZMPT101B AC sensor (expansion board) ---------------------------------
// ZMPT101B is a 2 mA : 2 mA current transformer with a burden resistor and an
// LM358 output stage. The OUT pin is a small AC waveform riding on ~1.5 V of
// DC bias, so RMS must be taken from the peak-to-peak excursion, NOT from the
// absolute ADC value. Measuring the raw pin against ground would read the bias
// as ~1.5 V of DC and be meaningless.
//
// Pin choice is forced by the ADC, not preference:
//   * ESP32-S3 ADC1 = GPIO1..GPIO10. ADC2 = GPIO11..GPIO20 is NOT usable while
//     Wi-Fi is active, and this device is always on Wi-Fi.
//   * GPIO0 and GPIO3 are strapping pins - do not use for analog.
//   * RELAY_PINS already occupy GPIO4..15 and GPIO18.
//   => GPIO1 and GPIO2 are the only free ADC1 pins, which is exactly one
//      voltage/current pair. A second meter would require moving relays off
//      ADC1 or accepting an ADC2 reading loss.
#define ZMPT_VOLT_PIN 1   // ADC1_CHANNEL_0
#define ZMPT_CURR_PIN 2   // ADC1_CHANNEL_1

// Samples per RMS window. 1000 samples at roughly 1 kHz spans several cycles
// of a 50/60 Hz waveform, so one mains cycle is captured comfortably.
#define ZMPT_SAMPLE_COUNT 1000

// Calibration factor: measured RMS / uncalibrated RMS.
// Set to 1.0 until the sensor is wired, then tune against a multimeter and a
// known load. Until this is calibrated the value is indicative only.
#define ZMPT_VOLT_CAL 1.0f
#define ZMPT_CURR_CAL 1.0f

// Samples below this peak-to-peak count are treated as "no signal". The output
// sits at its DC bias when the primary carries no current, so a tiny excursion
// is an idle channel, not a reading of zero that should still be published.
#define ZMPT_NOISE_FLOOR 12

// ---- PZEM-004T v3.0 bus --------------------------------------------------
// 13-channel rig: single mains PZEM (address 1) on the common feed.
// Per-channel watts are estimated from the mains total (see .ino).
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

// Provenance reported to the backend with every telemetry batch (D8). The
// backend labels the dashboard charts from this instead of hardcoding a claim,
// so the UI stays honest in both bench and metered states. The value posted is
// derived from SIMULATE_METERS: 1 = Simulated, 2 = Metered.
#define REPORT_METERING_MODE

// ---- Relay outputs, one per outlet channel ----
// Order: 8x220V (CH1-8), 1x110V via step-down (CH9), 4xUSB 5V (CH10-13).
// Safe ESP32-S3 GPIOs avoiding strapping (0,3,45,46), USB (19,20) and SPI flash.
static const uint8_t RELAY_PINS[OUTLET_COUNT] = { 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18 };
#define RELAY_CLOSED_LEVEL HIGH

// ---- Manual switch inputs, raw rocker/switch caps (0 = not wired) ----
// 0 means "no switch on this channel": handleManualSwitch() returns early on a
// zero pin, so an unwired channel is inert rather than reading a floating
// input. The prototype has NO rocker switches fitted -- the full-width literal
// is deliberate so every channel is explicitly documented as unwired, rather
// than a short initialiser leaving the intent ambiguous.
static const uint8_t SWITCH_PINS[OUTLET_COUNT] = {
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
};

// ---- Local autonomy ----
#define LOCAL_AUTO_SHED true
#define FAULT_TRIP_COUNT 3
#define SWITCH_DEBOUNCE_MS 50
