// MOR power-management prototype — ESP32 edge controller.
//
// Each loop iteration the firmware:
//   1. reads one mains PZEM-004T v3.0 (Modbus address 1) and estimates
//      per-channel watts from the mains total,
//   2. evaluates the ECA policy table locally (POL-01..POL-08 twins),
//   3. drives thirteen relay channels (8x220V + 1x110V + 4xUSB),
//   4. POSTs telemetry to the backend and periodically re-syncs config.
//
// The backend (ASP.NET Core + Neon) is the system of record; the ESP32 keeps
// running the last synced policy table when the network drops.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>
#include <Preferences.h>

#include "config.h"

// Desired-state codes from GET /api/Device/config (OutletStatus enum order).
#define DESIRED_ACTIVE 0
#define DESIRED_STANDBY 1

// Single mains meter for the 13-channel rig (common feed, address 1).
// Per-channel power is estimated from the mains total weighted by allowance.
PZEM004Tv30 mainsMeter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN, 0x01);

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
// Defaults match the 13-channel rig: 8x500W + 300W + 4x25W, P_limit 3600W.
float cfgLimit = 3600;        // P_limit
float cfgWarning = 3240;
float cfgStandby = 80;
int cfgStabilizationMs = 500;
int prioRank[OUTLET_COUNT] = { 0, 1, 1, 2, 2, 3, 3, 3, 2, 3, 3, 3, 3 };
float allowanceW[OUTLET_COUNT] = { 500, 500, 500, 500, 500, 500, 500, 500, 300, 25, 25, 25, 25 };
bool desiredEnergized[OUTLET_COUNT] = { false, false, false, false, false, false, false, false, false, false, false, false, false };
bool configSynced = false;

// On-device copy of the policy table (NVS flash). The protection logic runs
// from this copy, so the prototype enforces the last synced policy even with
// no network, and resumes it immediately on power-up.
Preferences nvsPolicy;
const uint32_t POLICY_MAGIC = 0x4D4F5232;  // "MOR2": 16-bit desired mask for 13 channels
unsigned long missedPosts = 0;

bool sFault = false;
unsigned long lastTelemetryAt = 0;
unsigned long lastConfigAt = 0;

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
  float simV = 220.0f + sin(millis() / 9000.0f) * 2.0f;
  float simC = simDenom > 0 ? simTotal / simV : 0;
  simEnergy += simTotal * (200.0f / 3600000.0f);  // ~200ms loop slice
  for (int i = 0; i < OUTLET_COUNT; i++) {
    channels[i].voltage = simV;
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].current = simDenom > 0 ? simC * (allowanceW[i] / simDenom) : 0;
      channels[i].power = simDenom > 0 ? simTotal * (allowanceW[i] / simDenom) : 0;
    } else {
      channels[i].current = 0;
      channels[i].power = 0;
    }
    channels[i].energy = simEnergy;
  }
  channels[0].faultStreak = 0;
  return;
#endif
  float v = mainsMeter.voltage();
  float c = mainsMeter.current();
  float p = mainsMeter.power();
  float e = mainsMeter.energy();

  if (isnan(v) || isnan(c) || isnan(p)) {
    // POL-01 hardware fault isolation (single mains meter unreadable).
    channels[0].faultStreak++;
    if (channels[0].faultStreak >= FAULT_TRIP_COUNT && !sFault) {
      sFault = true;
      Serial.println("POL-01: S_fault TRUE (mains meter unreadable), all relays opened");
    }
    return;
  }

  channels[0].faultStreak = 0;

  // Distribute the mains total across energized channels weighted by allowance.
  float denom = 0;
  for (int i = 0; i < OUTLET_COUNT; i++) {
    if (channels[i].relayClosed || desiredEnergized[i]) denom += allowanceW[i];
  }
  for (int i = 0; i < OUTLET_COUNT; i++) {
    channels[i].voltage = v;
    if (channels[i].relayClosed || desiredEnergized[i]) {
      channels[i].current = denom > 0 ? c * (allowanceW[i] / denom) : 0;
      channels[i].power = denom > 0 ? p * (allowanceW[i] / denom) : 0;
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
  uint8_t prio[OUTLET_COUNT];
  for (int i = 0; i < OUTLET_COUNT; i++) prio[i] = (uint8_t)prioRank[i];
  nvsPolicy.putBytes("prio", prio, OUTLET_COUNT);
  nvsPolicy.putBytes("allow", allowanceW, sizeof(allowanceW));
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
  uint8_t prio[OUTLET_COUNT];
  if (nvsPolicy.getBytes("prio", prio, OUTLET_COUNT) == OUTLET_COUNT) {
    for (int i = 0; i < OUTLET_COUNT; i++) prioRank[i] = prio[i];
  }
  float allow[OUTLET_COUNT];
  if (nvsPolicy.getBytes("allow", allow, sizeof(allow)) == sizeof(allow)) {
    memcpy(allowanceW, allow, sizeof(allow));
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

  JsonArray outlets = doc["outlets"];
  for (JsonObject o : outlets) {
    int ch = (int)o["channelId"] - 1;
    if (ch < 0 || ch >= OUTLET_COUNT) continue;
    prioRank[ch] = o["priority"] | 1;
    allowanceW[ch] = o["allowanceWatts"] | 0.0f;
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
  // Per-channel snapshot: C = relay closed, o = relay open.
  // CH1-8 = 220V outlets, CH9 = 110V outlet, CH10-13 = USB sockets.
  Serial.print("channels:");
  for (int i = 0; i < OUTLET_COUNT; i++) {
    Serial.printf(" %d:%s%.0fW", i + 1, channels[i].relayClosed ? "C" : "o", channels[i].power);
  }
  Serial.println();
  http.end();
  return ok;
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
#if SIMULATE_METERS
  Serial.println("SIM mode: synthetic mains readings (no PZEM wired)");
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

#ifdef LED_BUILTIN
  digitalWrite(LED_BUILTIN, (now / 500) % 2 ? HIGH : LOW);
#endif

  delay(200);
}
