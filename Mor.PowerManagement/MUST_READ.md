# MUST READ — LoadWise / Mor Power Management

> **READ THIS BEFORE TOUCHING ANYTHING IN THIS PROJECT.**
>
> **Status: TEMPORARY TEST CONFIGURATION — valid until 31 October 2026 (end of month).**
> The system is currently running a reduced **testing rig** for the practice run and
> Design 1 presentation. Everything in this file is the operating agreement for that
> period. Do **not** delete this file, and do **not** "clean up" the temporary sections
> before 31 Oct 2026 — the panel, firmware, seeds and demo all depend on them.
> The full 13-channel rig is restored afterwards per §9.

---

## 1. What this system is

**Thesis:** *Context-Aware Selective Load Response and Usage-Policy Management for
Shared Laboratory Spaces* (PTC-ACBET Criterion 6 — electrical/electronics laboratory
resources).

One sentence: a tower-style power strip whose outlets are governed by a **Framework** —
a set of machine-executable rules (FR-01..FR-12) evaluated continuously in an ECA loop
that decide, per outlet, whether to **allow, block, shed, preserve or fault-isolate** a
branch load.

| Term | Means |
|---|---|
| **Framework** | The whole governance structure: rules + decision logic + precedence + configuration store. (Replaces the old "policy/enforcement" wording in the manuscript.) |
| **Decision Point (DP)** | Web dashboard + backend API config in Neon PostgreSQL. Sets thresholds, priorities, lab profiles. |
| **Execution Point (EP)** | ESP32-S3 firmware. Executes the same rules locally, drives relays, syncs with DP. |
| **FR-xx** | Framework Rule. Replaces `POL-xx` everywhere (code, seeds, dashboard, thesis text). Crosswalk in §6. |
| **ECA** | Event → Condition → Action rule body, evaluated every loop tick. |
| **P_total** | Sum of **all** branch watts, **including the USB rail** (see §2). |
| **P_limit** | The critical system threshold that drives shedding. **1200 W during testing.** |
| **P_branch** | One outlet channel's measured watts. |

Two engines, one framework. The DP (backend) evaluates on every telemetry batch and is
what the dashboard shows; the EP (firmware) evaluates locally every loop tick so the rig
is still safe if the Wi-Fi or backend drops. **They must implement the identical rule
list.** When both are alive, DP decisions win (the firmware applies `desiredStatus` from
`GET /api/Device/config`).

---

### Sensors and libraries (firmware)

The PZEM-004T is **retired**. Metering is split across two I²C devices on a shared
bus (**SDA = GPIO 17, SCL = GPIO 18** — chosen to avoid relay GPIOs 4–8, strapping
pins 0/3/45/46, USB pins 19/20 and flash pins):

| Device | Role | I²C address | Library |
|---|---|---|---|
| **INA226** | Voltage reference on the common 220 V feed (behind a divider), plus DC rail monitoring. **Not a mains power meter** — see §12. | `0x40` | `INA226` (Rob Tillaart) v0.6.6 |
| **ADS1015 / ADS1115** | 4-channel ADC reading each branch's analog CT sensor → real per-branch current for CH1–CH4 | `0x48` | `Adafruit ADS1X15` v2.6.2 (+ `Adafruit BusIO`) |
| ArduinoJson | telemetry / config JSON | — | v7.4.3 |

Install once per machine (sketchbook on this PC is `D:\Arduino15\user\libraries`):

```powershell
arduino-cli lib install "ArduinoJson"
arduino-cli lib install "Adafruit ADS1X15"
arduino-cli lib install "INA226"
```

### Calibration constants — do not guess these

| Constant | Value | What breaks if it is wrong |
|---|---|---|
| `INA226_SHUNT_OHM` / `INA226_MAX_CURRENT_AMPS` | **0.010 Ω / 8.0 A** | The INA226 derives current from the shunt voltage. A wrong pair scales **every** current and watt reading on the dashboard. Using `configure(0.1, 0.1, …)` produced 0.000 A on all four channels while the sensor was healthy. |
| `INA226_MAIN_VOLT_DIVIDER` | **9.46** | Reported volts. 24.1 V at the pin × 9.46 = 228 V. |
| `I2C_CLOCK_HZ` | **100000** | A 400 kHz build found *neither* I²C device on the current wiring. If sensors vanish, check the bus first, then this. |
| `ZMCT_CAL_FACTOR` | **0.52** | Every branch amp is this × the measured RMS. Calibrate against a known load. |
| `AC_VOLTAGE` (raw sketch) | **238** — see §12 | Only affects the standalone raw sketch; the framework firmware uses measured volts instead. |

**Electrical cautions — read before wiring:**
- The INA226 senses **max 36 V**. It must sit behind a **voltage divider on the
  220 V mains feed**; never connect mains directly. `INA226_MAIN_VOLT_DIVIDER`
  (default `4.0`) is passed to `configure(..., bus_V_scaling_e4)` so the reported
  volts are real mains volts. For 220 V use ≈ 3 × 1 MΩ + 1 MΩ (ratio 4).
- The INA226 has **no energy register**; the firmware integrates power into a
  cumulative kWh (`integratedEnergyWh`).
- `ZMCT_ZERO_MV` (2500) is the CT's 0 A centre and `ZMCT_MV_PER_AMP` (1.0) its
  ratio — **calibrate both against a known load** (e.g. clamp 1 A, read serial).
- The **USB rail (CH5) has no CT**. Its wattage is reported as the residual:
  mains total minus the four measured branches.
- `INA226` (`0x40`) and `ADS` (`0x48`) addresses must not collide.
- `SIMULATE_METERS` in `config.h` is `1` (synthetic) until the sensors are wired;
  set `0` for real readings. Both paths are compile-verified.

## 2. Testing rig (TEMPORARY — until 31 Oct 2026)

| Channel | Hardware | Relay GPIO (ESP32-S3) | Voltage class | Priority | Allowance |
|---|---|---|---|---|---|
| CH1 | Outlet 1 — Instructor workstation | 4 | 220 V | Critical | 300 W |
| CH2 | Outlet 2 — Demo equipment | 5 | 220 V | High | 300 W |
| CH3 | Outlet 3 — Lab instrument | 6 | 220 V | High | 300 W |
| CH4 | Outlet 4 — Student workstation | 7 | 220 V | Medium | 300 W |
| CH5 | USB 5 V charging | 8 | 5 V | Low | 10 W |

- **Firmware:** `OUTLET_COUNT 5`, `RELAY_PINS[] = {4,5,6,7,8}` in
  `firmware/mor-power-device/config.h`.
- **Backend seed:** only 5 outlets seeded (`ApplicationDbContextInitialiser.cs`); the
  CH6..CH13 rows are not created while testing. The old 8-outlet + 110 V + 4-USB spec is
  frozen in git and restored in §9.
- **The USB rail counts toward P_total.** This is a deliberate change from the
  Chapter 1 manuscript wording ("excluded from the load-shed logic") — the manuscript is
  updated at manuscript time, the code follows this doc.
- **110 V auxiliary socket:** not present on the test rig. When it returns, it is
  metered and reported but is **never** a shed candidate.
- Expect ~1200 W of real load across 4 outlets: keep the bench under the cap or the
  demo will shed during setup.

### Testing thresholds (TEMPORARY)

| Parameter | Value | Notes |
|---|---|---|
| `MaxCapacityWatts` | **1200 W** | hard software cap; matches P_limit during testing |
| `CriticalThresholdWatts` (P_limit) | **1200 W** | **capped for testing** |
| `WarningThresholdWatts` | **960 W** | 80 % of P_limit, hysteresis clears at 900 W |
| `StandbyThresholdWatts` | **80 W** | branch ≤ 80 W with relay closed = standby |
| `StandbyIdleMinutes` | 30 | idle → shed |
| `StabilizationDelayMs` | 500 | post-activation verification window |
| `NominalVoltageVolts` / tolerance | 220 V ± 10 % | 198–264 V class window |
| Branch overcurrent factor | 1.25 × rated | FR-03 latch |
| Thermal slew | 400 W/min branch | alarm only |
| Shed per cycle | 1 outlet | small rig: shed one at a time, re-assess |
| Shed cooldown | 60 s | no outlet auto-shed twice inside 60 s |
| Fault latch | 300 s | manual ack required (DP) |

### Lab profiles (context multiplier on the globals)

| Profile | P_limit | Warning | Idle | Shed Medium? |
|---|---|---|---|---|
| **Bench Instrumentation** (default for the panel) | 1200 W | 960 W | 30 min | no |
| Embedded Prototyping | 1200 W | 960 W | 60 min | no (soldering stations = Critical) |
| Tutorial | 1000 W | 800 W | 15 min | yes |
| Heavy Machinery | 1500 W | 1200 W | 45 min | yes (long-running motors) |

---

## 3. The Framework rules (FR-01 .. FR-12)

Ordered by precedence. **Precedence resolves conflicts: the lowest-numbered rule that
fires wins for a given branch in a given tick.** Every rule body is ECA.

### Family A — Safety & Interlock (highest precedence, latched)

| ID | Condition | Action | Target | PTC-ACBET basis |
|---|---|---|---|---|
| **FR-01** | `S_fault` TRUE (mains meter unreadable / comm loss) for 3 consecutive ticks | `ACT_FAULT` — open **all** relays, latch, `PowerEvent(Critical)`, DP shows `RESTRICTED` | Whole unit | §1 emergency master power shut-off, overcurrent protection |
| **FR-02** | Branch voltage outside 198–264 V (or > 242 V class for a 5 V rail report flag) for 2 consecutive ticks (~10 s) | `ACT_BLOCK` new activation; `ACT_SHED` the branch; latch; require manual ack | Branch | §1 electrical codes / grounded workstations |
| **FR-03** | `I_branch > 1.25 × rated amps` for 2 consecutive ticks | `ACT_SHED` branch + latch + `PowerEvent(Critical)` | Branch | §1 overcurrent protection, equipment rating |

### Family B — Pre-Activation (context check before a relay closes)

| ID | Condition | Action | Target | PTC-ACBET basis |
|---|---|---|---|---|
| **FR-04** | `Request(i)` AND `P_total + Allowance(i) ≤ P_limit` AND not latched AND within schedule | `ACT_ALLOW(i)` after `StabilizationDelay` | Branch | §2 one instrument per workstation |
| **FR-05** | `Request(i)` AND (`P_total + Allowance(i) > P_limit` OR latched OR outside schedule) | `ACT_DENY(i)` — relay stays open, reason logged in `PowerEvent(Warning)` | Branch | §2 shared-resource fairness |

### Family C — Post-Activation Verification

| ID | Condition | Action | Target |
|---|---|---|---|
| **FR-06** | `t ≥ 500 ms` after `ACT_ALLOW(i)` AND `P_total > P_limit` | `ACT_SHED(i)` — revert the *newest* activation first (never a Critical branch) |

### Family D — Demand-Side / Selective Shedding

| ID | Condition | Action | Target |
|---|---|---|---|
| **FR-07** | `P_total > P_limit`, hysteresis-clear at 900 W, after 2 consecutive ticks | `ACT_SHED` the **lowest-priority energized** branch, one branch per cycle, re-assess every cycle | Lowest priority (Low → up) |
| **FR-08** | Overload persists after **all** Low and Medium are shed | `ACT_SHED` next Medium priority; Critical/High still preserved | Medium |
| **FR-09** | Any shed cycle while a High/Critical branch is energized | `ACT_PRESERVE(i)` — High/Critical are **never** shed candidates in FR-07/08 | High + Critical |

### Family E — Standby / Idle

| ID | Condition | Action | Target |
|---|---|---|---|
| **FR-10** | `P_branch ≤ 80 W` continuously for **30 min** (or branch `IdleLimitMinutes` if set) with no user interaction and no DR increase | `ACT_SHED(i)` → Disconnected | Branch |

### Family F — Measurement, Audit, Compliance

| ID | Condition | Action | Target | PTC-ACBET basis |
|---|---|---|---|---|
| **FR-11** | `CalibrationDueAt < now` for the branch's instrument class | downgrade branch Critical→High, badge on dashboard, exempt from FR-09 preservation | Branch | §4 calibration & maintenance trails |
| **FR-12** | Any rule fires (any family) | persist a `RuleAuditRow` (ruleId, branch, trigger snapshot, action, severity, actor) + `PowerEvent` | System | §1 documented audit evidence |

**Aux rail rule (not FR):** the 110 V socket (when it returns) is metered and reported
but is never a shed candidate; the **USB rail (CH5) counts toward P_total and IS a shed
candidate, lowest priority by default.**

### Precedence summary

```
FR-01 fault isolate  >  FR-02 voltage  >  FR-03 overcurrent
      >  FR-04/05 pre-activation  >  FR-06 post-activation recheck
      >  FR-07/08 shedding (Low → Medium)  >  FR-09 preserve High/Critical
      >  FR-10 idle  >  FR-11 calibration downgrade  >  FR-12 audit
```

---

## 4. Sensor → decision → actuation (the live loop, COM10)

This is the exact path by which **plugging in the ESP32 results in relays physically
dropping automatically.** Do not break this chain.

```
ESP32-S3, every 5000 ms
  1. read/derive per-branch V/A/W
       SIMULATE_METERS=1 : synthesised from allowances (bench, no sensors)
       SIMULATE_METERS=0 : INA226 (mains V/A/W) + ADS1x15 (per-branch CT current);
                           CH5 USB = mains total minus the four measured branches
  2. POST /api/Device/telemetry   { deviceId, sFault, meteringMode, readings[5], relayStates[5] }
       (X-Device-Key header required when Device:ApiKey is set)
  3. BACKEND, in order, single transaction:
       validate ranges → persist TelemetryReading rows
       → update Outlet.CurrentWatts / LastSeen
       → reconcile relay reports (60 s command-grace window)
       → evaluate FR-01..FR-12 in precedence order
       → apply actions: set Outlet.Status (Active/Standby/Restricted/Disconnected)
       → FR-12: PowerEvent + RuleAuditRow per firing
       → return { totalWatts, state, actions[], alerts[] }
  4. ESP32, every 15000 ms:
       GET /api/Device/config  → desiredStatus per channel + thresholds
       → desiredEnergized[ch] = (desired == Active || Standby)
       → FAIL-SAFE: relay opens when !desiredEnergized[ch] || localShed || sFault
  5. ESP32, every tick (offline autonomy):
       local FR-01 (sFault → all relays open) and local FR-07 (P_total > P_limit → shed
       lowest priority). Local sheds release when headroom returns. DP overrides on next sync.
```

**Latency to relay drop after an overload appears:** telemetry 5 s + backend evaluation
(same request) + config poll ≤ 15 s ≈ **≤ 20 s worst case, typically < 5 s** because the
local shed in the firmware acts within the same 5 s loop tick when offline-capable.

**Dashboard auto-shed is real, not theatre:** shedding happens in the backend engine and
reaches the relays through `desiredStatus`. Manual buttons (`activateOutlet`,
`disconnectOutlet`, `applySelectiveResponse`) write through the same path. The scenario
ingest endpoint (`POST /api/Dashboard/scenarios/ingest`) writes genuine rows with the same
engine, so demo actions move the Telemetry charts.

---

## 5. How we validate the Framework

Validation is a pyramid — every level must pass before the next is trusted. Log results
in `TESTING_LOG.md` per run.

**L1 — Static validation (config validators, unit tests)**
- Threshold ordering enforced by `UpdateThresholdsCommandValidator`:
  `warning < critical ≤ capacity`, all > 0.
- `IngestTelemetryCommandValidator`: V 0–300, A 0–100, W 0–5000 per branch.
- `PowerSystemConfig` invariant: exactly one row.
- `FR`-identifier check: every `ControlPolicy` row has a valid `FR-xx` code, a legacy
  `POL-xx` mapping, a precedence order, and `Enabled = true`.
- Unit tests: `LoadResponseEvaluator` + new rule functions (Hysteresis, Window,
  priority ordering, USB inclusion in P_total).

**L2 — Rule matrix (behavioural, one test per rule, expected outcome recorded)**

| Rule | Test setup | Expected | Evidence |
|---|---|---|---|
| FR-01 | post `sFault: true` | all 5 relays open, statuses Restricted, Critical event | serial `POL-01/FR-01`, dashboard banner |
| FR-02 | post readings with V=180 on CH3 | CH3 shed + latched, deny further activation | PowerEvent + audit row |
| FR-03 | post I > 1.25× rating on CH2 for 2 ticks | CH2 shed + latched | audit row |
| FR-04 | P_total 300 W, request CH4 | allowed, relay closes after 500 ms | config sync shows Active |
| FR-05 | P_total ≥ 1200 W, request CH4 | denied, relay open, Warning event | audit row |
| FR-06 | activate CH4 while over cap | CH4 shed again (newest first) | audit row |
| FR-07 | push P_total to 1300 W | lowest-priority branch (USB/CH5) shed; Critical/High untouched | serial + dashboard |
| FR-08 | keep overload after Low/Medium shed | Medium shed next; Critical preserved | audit rows |
| FR-09 | keep overload, CH1 Critical energized | CH1 never shed | audit rows |
| FR-10 | branch ≤ 80 W for 30 min | shed → Disconnected | audit row |
| FR-11 | set `CalibrationDueAt` past | branch not preserved, badge shown | dashboard |
| FR-12 | any of the above | one audit row per firing with trigger snapshot | `GET /api/Dashboard/rules/audit` |

**L3 — Loop / integration (live rig, COM10)**
- Serial @115200: `IP:` → `config synced: P_limit=1200 W, 5 channels` → `telemetry: HTTP 200` every 5 s.
- Dashboard `ESP32 online` pill (telemetry within 30 s).
- **End-to-end relay drop:** trigger an overload (heavy load or scenario) and physically
  confirm the relay(s) open within 20 s and the outlet card flips to Disconnected with the
  rule ID in the event log.
- USB-in-P_total check: `P_total` on the dashboard must move when a USB device is
  connected/disconnected.
- Backend outage test: stop the API, confirm relays still protect (local FR-01/FR-07 on
  serial), confirm `HTTP -1` then recovery resync.

**L4 — Traceability (thesis defence)**
- Every FR-xx maps to one PTC-ACBET Criterion 6 clause (table in §3).
- Every FR-xx maps to one L2 test case and its evidence.
- Crosswalk `POL-xx → FR-xx` documented for the manuscript (§6).
- Screen-record the L3 relay drop and the dashboard for the defense.

---

## 6. Policy → Framework rule crosswalk (for the manuscript)

| Legacy | New ID | Name |
|---|---|---|
| POL-01 | **FR-01** | Hardware Fault Isolation |
| POL-02 | **FR-04** | Pre-Activation Assessment |
| POL-03 | **FR-05** | Pre-Activation Denial |
| POL-04 | **FR-06** | Post-Activation Verification |
| POL-05 | **FR-07** | Load Shedding Level 1 |
| POL-06 | **FR-08** | Load Shedding Level 2 |
| POL-07 | **FR-09** | Priority Preservation |
| POL-08 | **FR-10** | Standby Load Management |
| — | **FR-02** | Voltage Window Protection *(new)* |
| — | **FR-03** | Branch Overcurrent Protection *(new)* |
| — | **FR-11** | Calibration Due Downgrade *(new)* |
| — | **FR-12** | Rule Audit Trail *(new)* |

Terminology in the manuscript: **Framework** (not policy/enforcement), **Decision Point /
Execution Point** (not server/device), **FR-xx** (not POL-xx). Keep the crosswalk table so
earlier panels remain quotable.

---

## 7. Where things live

| Concern | Path |
|---|---|
| Rule engine (pure functions) | `src/Domain/Services/LoadResponseEvaluator.cs` |
| Enums | `src/Domain/Enums/` (`OutletStatus`, `OutletPriority`, `SystemState`, `MeteringMode`) |
| Entities | `src/Domain/Entities/` (`Outlet`, `PowerSystemConfig`, `ControlPolicy`, `PowerEvent`, `TelemetryReading`) |
| Ingest + evaluation | `src/Application/Power/Commands/IngestTelemetry/` |
| Commands/queries | `src/Application/Power/**` (MediatR) |
| Endpoints | `src/Web/Endpoints/Dashboard.cs`, `Device.cs` |
| Seed data (thresholds, outlets, FR rows) | `src/Infrastructure/Data/ApplicationDbContextInitialiser.cs` |
| Migrations | `src/Infrastructure/Data/Migrations/` |
| Frontend API client | `src/Web/ClientApp/src/api.ts` |
| Dashboard fallback constants | `src/Web/ClientApp/src/data/dashboard.ts` |
| Scenario builders | `src/Web/ClientApp/src/utils/scenarios.ts` |
| Firmware | `firmware/mor-power-device/mor-power-device.ino`, `config.h` (`OUTLET_COUNT 5`, relays `{4,5,6,7,8}`) |
| Flash commands | §8 of this file (COM10) |
| Old full-rig architecture | `docs/ARCHITECTURE.md` — read for the final 13-channel design; **this file overrides it until 31 Oct 2026** |

---

## 8. Change discipline (read before changing anything)

1. **A threshold change is a 4-file change** or the system silently disagrees with itself:
   `ApplicationDbContextInitialiser.cs` (seed) →
   `PowerSystemConfig` defaults → `ClientApp/src/data/dashboard.ts` constants →
   `firmware/mor-power-device/config.h` (P_limit in the local shed) → update §2 here.
2. **Every new rule gets:** an `FR-xx` id, a `ControlPolicy` row with `LegacyCode`, a
   precedence slot, a `LoadResponseEvaluator` function, a firmware counterpart, a row in
   the §3 table, and an L2 test case. Missing any one = not done.
3. **Minimum 4 decimals / units in code comments and in the manuscript** — W, V, A, ms,
   min. No bare numbers.
4. **Never relax FR-01/02/03** for a demo. Those are the PTC-ACBET evidence.
5. **Secrets:** `Device:ApiKey` and `DEVICE_API_KEY` live in user-secrets / firmware
   `config.h` (not committed) — never paste real keys into commits, tests or docs.
6. **Testing rig is wired in git:** `git worktree`/branch names for testing are fine;
   keep `main` on the full rig. Mention the branch in every panel caption.
7. **Build/verify before demo:** `dotnet build` (warnings-as-errors),
   `dotnet test tests/Domain.Unit tests && dotnet test tests/Application.UnitTests`,
   ClientApp `npx tsc --noEmit && npm test`. (The repo has no ESLint config, so
   `npm run lint` cannot run; TypeScript + vitest are the gates.) Failing tests
   block the demo.
8. **Before the panel:** run the §5 L3 checklist start to finish and screen-record.

### ESP32 on COM10 — quick start

```powershell
# 1. build firmware with the testing rig (OUTLET_COUNT 5, RELAY_PINS {4,5,6,7,8})
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
# 2. detect the board
arduino-cli board list
# 3. flash
arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
# 4. watch serial @115200: IP → config synced (P_limit=1200, 5 channels) → telemetry 200
arduino-cli monitor -p COM10 -b 115200
# 5. run the backend for the LAN
dotnet run --project src/Web --urls http://0.0.0.0:5211
# 6. dashboard: http://<pc-ip>:5211 — log in (administrator@localhost / Administrator1!)
```

If `esptool` says "This chip is ESP32-S3", you used the `esp32` FQBN; use `esp32s3`.

---

## 9. Restore checklist (after 31 Oct 2026)

Do these when the practice/design 1 phase ends:

1. `OUTLET_COUNT 13`, `RELAY_PINS[] = {4,5,6,7,8,9,10,11,12,13,14,15,18}` in
   `firmware/config.h`.
2. Flip `const bool TestingRig = false;` in
   `ApplicationDbContextInitialiser.cs` — the full 13-channel spec and the
   4000/3240/3600 thresholds come back from the same file.
3. Restore `ClientApp/src/data/dashboard.ts` constants (4000/3240/3600) and the 13
   `baseOutlets`; restore `ALL_CHANNEL_IDS` to 13 in `src/data/telemetry.ts` and
   `ALL_CHANNELS` to 13 in `src/api.ts`.
4. Remove the `app-rig-pill` badge from `AppTopBar.tsx` and its `.app-rig-pill`
   rule in `styles.css`; flip the copy back to 13 channels in
   `TelemetryView.tsx`, `HardwareView.tsx`, `data/telemetry.ts`.
5. Re-run L1–L3 against the full rig, capture new evidence.
6. Decide (and record here) whether USB stays in P_total for the final rig — the
   manuscript currently says excluded; §2 of this doc says included.

---

*Last updated 11 Oct 2026. Testing rig configuration in force until 31 Oct 2026.*

---

## 12. Bench reality (recorded 11 Oct 2026)

What the rig actually does right now, as opposed to what the design intends.

**Working, measured on the bench:**
- INA226 online at 0x40, reading 227.6 V after the 9.46 divider
- ADS1015 online at 0x48, four CT channels reading 0.059 / 0.029 / 0.024 / 0.025 A
- Telemetry HTTP 200 at 1 Hz; dashboard total 30.81 W against a 1200 W limit
- Relays and rules are disabled (RELAY_OUTPUT_ENABLED 0, RULES_ENABLED 0), so nothing can shed or trip

**Two honest gaps to resolve before the write-up:**
1. **The INA226 is not a mains power meter.** It sits on a 24 V DC rail that is
   drawing ~0 A, so mains power and kWh read ~0. It is currently useful only as
   the voltage reference (24.1 V x 9.46). Either rewire it to the mains feed, or
   describe it in the manuscript as a voltage reference, not as P_total.
2. **Branch volts are measured; the raw sketch's AC_VOLTAGE is assumed.**
   The framework firmware multiplies measured branch current by the measured
   INA226 voltage. The standalone raw sketch instead assumes a constant 238 V
   while the bench meter reads 228 V, so its watt figures are ~4% high.

**Failure modes worth remembering:**
- The ESP32 enumerates on a **different COM port after every replug** (it has been
  COM10, COM11 and COM12 today). A missing port looks identical to an I2C fault.
- The bus has gone silent three times today, each time after the wiring was
  handled. Long-term fix: solder or lock the sensor VCC/GND rather than Dupont.
- An INA226 that reports 0 A is usually a **shunt calibration** fault, not a dead
  sensor. Confirm the bus answers before suspecting hardware.
