#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// MOR power-management prototype — ESP32 edge controller.
// Edit the values below for your bench, then compile and flash with:
//   arduino-cli compile --fqbn esp32:esp32:esp32 firmware/mor-power-device
//   arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32 firmware/mor-power-device
// ---------------------------------------------------------------------------

#define OUTLET_COUNT 13

// ---- Wi-Fi ----
// Credentials live in NVS flash (written on first setup), so the repo never
// holds a real password. These are first-boot seeds only.
#define WIFI_SSID ""
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

// ---- PZEM-004T v3.0 bus ----
// 13-channel rig: single mains PZEM (address 1) on the common feed.
// Per-channel watts are estimated from the mains total (see .ino).
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

// Placeholder for bench tests without hardware wired:
// 1 = synthesize mains readings (no PZEM needed), 0 = read the real PZEM.
#define SIMULATE_METERS 1

// ---- Relay outputs, one per outlet channel ----
// Order: 8x220V (CH1-8), 1x110V via step-down (CH9), 4xUSB 5V (CH10-13).
// Safe ESP32-S3 GPIOs avoiding strapping (0,3,45,46), USB (19,20) and SPI flash.
static const uint8_t RELAY_PINS[OUTLET_COUNT] = { 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18 };
#define RELAY_CLOSED_LEVEL HIGH

// ---- Manual switch inputs, raw rocker/switch caps (0 = not wired) ----
static const uint8_t SWITCH_PINS[OUTLET_COUNT] = { 0, 0, 0, 0, 0, 0 };

// ---- Local autonomy ----
#define LOCAL_AUTO_SHED true
#define FAULT_TRIP_COUNT 3
#define SWITCH_DEBOUNCE_MS 50
