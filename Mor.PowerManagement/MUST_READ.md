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
| **P_total** | Sum of the four measured mains outlet branches; INA226 DC readings are separate. |
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
bus (**SDA = GPIO 8, SCL = GPIO 9**).

The I²C pins are **fixed by the physical wiring, not chosen** — GPIO 8/9 are the pins
the sensors are actually soldered to on this rig, so they cannot be moved without
moving the wiring. The **relay GPIOs were the ones chosen**: they start at GPIO 10
specifically to stay clear of the I²C pair (8, 9), and they also avoid strapping pins
0/3/45/46, USB pins 19/20 and the SPI flash pins.

| Device | Role | I²C address | Library |
|---|---|---|---|
| **INA226** | **Voltage reference only.** On the current bench it sits on a 24 V DC rail drawing ~0 A, so it sees neither the mains feed nor any branch load. It contributes to **no** wattage figure — P_total is the sum of the four measured CT branches only. **Not a mains power meter** — see §12. | `0x40` | `INA226` (Rob Tillaart) v0.6.6 |
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
| `INA226_SHUNT_OHM` / `INA226_MAX_CURRENT_AMPS` | **0.1 Ω / 0.75 A** | The INA226 shunt input is limited to ±81.9 mV, so `Imax × Rshunt` must stay below that. The old 2 A × 0.1 Ω pair requested 200 mV; the library rejected calibration and `getCurrent()` / `getPower()` stayed at 0 while raw shunt mV changed. Firmware now checks and reports calibration failure. |
| `INA226_MAIN_VOLT_DIVIDER` | **9.46** | Reported volts. 24.1 V at the pin × 9.46 = 228 V. |
| `I2C_CLOCK_HZ` | **100000** | A 400 kHz build found *neither* I²C device on the current wiring. If sensors vanish, check the bus first, then this. |
| `ZMCT_CAL_FACTOR` | **0.52** | Every branch amp is this × the measured RMS. **Untrusted — see §12.** Calibrate against a known load. |
| `FALLBACK_MAINS_VOLTS` | **228.0 V** | Used **only** when the INA226 is not answering at all, so the rig still reports a plausible voltage instead of 0 V. It is not the normal source of reported mains volts. |
| `AC_VOLTAGE` (raw sketch) | **238 V** — see §12 | Only the standalone raw sketch uses it. The framework firmware **measures** mains volts instead: INA226 bus volts × `INA226_MAIN_VOLT_DIVIDER` (9.46), with `FALLBACK_MAINS_VOLTS` (228.0 V) as a fallback only. |

> **WARNING — editing a constant is not the same as changing it.**
>
> The framework firmware keeps **its own private copies** of the calibration constants
> in the `.ino` instead of reading them from `config.h`. Until it consumes `config.h`
> directly, editing a constant in `config.h` is silently ignored by the build — you
> can "fix" a shunt, a divider or a CT factor and watch the bench reading stay
> exactly where it was. **This has been a live hazard on this project, not a
> theoretical one.**
>
> **Fixed:** the firmware now reads these values from `config.h`.
> Until that fix is re-verified on the bench after any firmware change, grep the
> `.ino` for a duplicate literal before you assume your edit took effect (see §8).

**Electrical cautions — read before wiring:**
- The INA226 is connected to the ESP32 over I2C and measures its own DC shunt path. It is not a mains meter, not an outlet, and is never added to the mains load total. Never connect mains to the INA226.
- The four outlet CTs feed ADS1220 AIN0–AIN3. Each outlet's current is measured on its own branch.
- Mains voltage is the configured 238 V reference. The INA226 reading does not set or scale outlet voltage.
- `SIMULATE_METERS` is `0` on the bench: the firmware reads the INA226 and ADS1220 hardware.
## 2. Testing rig (four-outlet bench)

The bench has exactly four controlled AC outlets. The INA226 is connected to the ESP32 as a separate DC shunt monitor; it is sensor telemetry, not an outlet and not part of the mains load total.

| Channel | Hardware | Relay GPIO (ESP32-S3) | CT input | Voltage | Allowance |
|---|---|---:|---|---:|---:|
| CH1 | Outlet 1 | 1 | ADS1220 AIN0 | 238 V | 1100 W |
| CH2 | Outlet 2 | 2 | ADS1220 AIN1 | 238 V | 1100 W |
| CH3 | Outlet 3 | 4 | ADS1220 AIN2 | 238 V | 1100 W |
| CH4 | Outlet 4 | 5 | ADS1220 AIN3 | 238 V | 1100 W |

- Firmware uses `OUTLET_COUNT 4`, `BRANCH_CT_COUNT 4`, and `RELAY_PINS[] = {1, 2, 4, 5}`.
- INA226 uses its own I2C connection (SDA 8, SCL 9). Its readings are sent under the separate `ina` telemetry object, never as outlet ID 5.
- Backend testing seed and dashboard roster contain exactly outlets 1–4. Stale rows above outlet 4 are removed while the first four outlets and their telemetry history are retained.
- System capacity is 4400 W, with 3520 W warning and 4400 W critical thresholds.
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

**Separate sensor:** INA226 DC telemetry is reported independently and does not create an outlet, a relay, or mains load.

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
       SIMULATE_METERS=0 : ADS1220 measures four branch CTs; INA226 reports
                           its separate DC shunt telemetry. P_total sums only
                           the four mains outlets
  2. POST /api/Device/telemetry   { deviceId, faultFlag, meteringMode, readings[4], relayStates[4], ina }
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
| FR-01 | post `sFault: true` | all 4 relays open, statuses Restricted, Critical event | serial `POL-01/FR-01`, dashboard banner |
| FR-02 | post readings with V=180 on CH3 | CH3 shed + latched, deny further activation | PowerEvent + audit row |
| FR-03 | post I > 1.25× rating on CH2 for 2 ticks | CH2 shed + latched | audit row |
| FR-04 | P_total 300 W, request CH4 | allowed, relay closes after 500 ms | config sync shows Active |
| FR-05 | P_total ≥ 1200 W, request CH4 | denied, relay open, Warning event | audit row |
| FR-06 | activate CH4 while over cap | CH4 shed again (newest first) | audit row |
| FR-07 | push P_total above limit | lowest-priority eligible outlet shed; Critical/High untouched | serial + dashboard |
| FR-08 | keep overload after Low/Medium shed | Medium shed next; Critical preserved | audit rows |
| FR-09 | keep overload, CH1 Critical energized | CH1 never shed | audit rows |
| FR-10 | branch ≤ 80 W for 30 min | shed → Disconnected | audit row |
| FR-11 | set `CalibrationDueAt` past | branch not preserved, badge shown | dashboard |
| FR-12 | any of the above | one audit row per firing with trigger snapshot | `GET /api/Dashboard/rules/audit` |

**L3 — Loop / integration (live rig, COM10)**
- Serial @115200: `IP:` → `config synced: P_limit=4400 W, 4 channels` → `telemetry: HTTP 200` every 5 s.
- Dashboard `ESP32 online` pill (telemetry within 30 s).
- **End-to-end relay drop:** trigger an overload (heavy load or scenario) and physically
  confirm the relay(s) open within 20 s and the outlet card flips to Disconnected with the
  rule ID in the event log.
- INA226 check: its DC readings stay separate from the four-outlet mains P_total.
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
| Firmware | `firmware/mor-power-device/mor-power-device.ino`, `config.h` (`OUTLET_COUNT 5`, relays `{10,11,12,13,14}`, I²C SDA 8 / SCL 9) |
| Flash commands | §8 of this file (COM10) |
| Old full-rig architecture | `docs/ARCHITECTURE.md` — read for the final 13-channel design; **this file overrides it until 31 Oct 2026** |

---

## 8. Change discipline (read before changing anything)

1. **A threshold change is a 4-file change** or the system silently disagrees with itself:
   `ApplicationDbContextInitialiser.cs` (seed) →
   `PowerSystemConfig` defaults → `ClientApp/src/data/dashboard.ts` constants →
   `firmware/mor-power-device/config.h` (P_limit in the local shed) → update §2 here.
2. **A calibration constant is only real if the firmware consumes it.** Shunt, divider,
   CT factor and voltage fallback are changed in `config.h` — nothing else. Then
   **grep the `.ino` for a duplicate literal** before you assume the edit took effect:
   a private copy in the sketch silently outranks `config.h` and the bench reading
   will not move. This exact class of bug shipped in this rig (§12).
3. **Every new rule gets:** an `FR-xx` id, a `ControlPolicy` row with `LegacyCode`, a
   precedence slot, a `LoadResponseEvaluator` function, a firmware counterpart, a row in
   the §3 table, and an L2 test case. Missing any one = not done.
4. **Minimum 4 decimals / units in code comments and in the manuscript** — W, V, A, ms,
   min. No bare numbers.
5. **Never relax FR-01/02/03** for a demo. Those are the PTC-ACBET evidence.
6. **Secrets:** `Device:ApiKey` and `DEVICE_API_KEY` live in user-secrets / firmware
   `config.h` (not committed) — never paste real keys into commits, tests or docs.
7. **Testing rig is wired in git:** `git worktree`/branch names for testing are fine;
   keep `main` on the full rig. Mention the branch in every panel caption.
8. **Build/verify before demo:** `dotnet build` (warnings-as-errors),
   `dotnet test tests/Domain.Unit tests && dotnet test tests/Application.UnitTests`,
   ClientApp `npx tsc --noEmit && npm test`. (The repo has no ESLint config, so
   `npm run lint` cannot run; TypeScript + vitest are the gates.) Failing tests
   block the demo.
9. **Before the panel:** run the §5 L3 checklist start to finish and screen-record.

### ESP32 on COM10 — quick start

```powershell
# 1. build firmware with the testing rig (OUTLET_COUNT 5, RELAY_PINS {10,11,12,13,14})
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
# 2. detect the board
arduino-cli board list
# 3. flash
arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
# 4. watch serial @115200: IP → config synced (P_limit=4400, 4 channels) → telemetry 200
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

*Last updated 12 Oct 2026. Testing rig configuration in force until 31 Oct 2026.*

---

## 12. Bench reality (recorded 11 Oct 2026, amended 12 Oct 2026)

What the rig actually does right now, as opposed to what the design intends.

**Working, measured on the bench:**
- INA226 online at 0x40, reading 227.6 V after the 9.46 divider
- ADS1015 online at 0x48, four CT channels reading 0.059 / 0.029 / 0.024 / 0.025 A
- Telemetry HTTP 200 at 1 Hz; dashboard total 30.81 W against a 1200 W limit
- Relays and rules are disabled (RELAY_OUTPUT_ENABLED 0, RULES_ENABLED 0), so nothing can shed or trip

**Three honest gaps to resolve before the write-up:**
1. **The INA226 is not a mains power meter.** It currently sits on the rig's 24 V
   DC rail, so it does not measure mains power or contribute to mains P_total.
   The old 2 A / 0.1 Ω calibration requested 200 mV from an 81.9 mV-limited
   shunt input; the library rejected it and current/power stayed at zero while
   raw shunt mV changed. The firmware now uses 0.75 A / 0.1 Ω (75 mV full scale)
   and reports calibration errors at boot. Verify its live current against a
   meter under load. Rewire it before treating it as the intended 3.3 V or USB
   rail measurement.
2. **Branch volts are measured; the raw sketch's AC_VOLTAGE is assumed.**
   The framework firmware multiplies measured branch current by the measured
   INA226 voltage. The standalone raw sketch instead assumes a constant 238 V
   while the bench meter reads 228 V, so its watt figures are ~4% high.
3. **The CT channels read roughly 25x low, and `ZMCT_CAL_FACTOR` is not trusted.**
   Recorded: 0.059 / 0.029 / 0.024 / 0.025 A per channel against an expected
   ~1.37 A per branch at ~300 W. That is ~25x low, which is far outside anything
   `ZMCT_CAL_FACTOR 0.52` can explain, so the factor is either badly wrong or the
   CT chain is not measuring what we think it is. **Do not treat any branch watt
   figure from this rig as measured until the CTs are calibrated against a real
   known load.** A calibration mode has been added to the firmware
   (`ZMCT_CALIBRATION_MODE` / `ZMCT_CAL_REF_WATTS` in `config.h`); connect a
   known load, set the reference wattage, and the firmware prints the suggested
   factor. This is an **open item**, not a fix.

**Failure modes worth remembering:**
- The ESP32 enumerates on a **different COM port after every replug** (it has been
  COM10, COM11 and COM12 today). A missing port looks identical to an I2C fault.
- **Identified and fixed — the silent-bus cause was our own build.** The sketch
  was running `Wire.setClock(400000)` while the bench-proven rate for this wiring
  is **100 kHz** (`I2C_CLOCK_HZ 100000`): a 400 kHz build finds *neither* the
  INA226 (0x40) nor the ADS1015 (0x48). The same build also kept its own private
  copies of the calibration constants instead of reading `config.h`, so edits to
  `config.h` were being ignored. Both are the most likely cause of the bus going
  silent after the wiring was handled. The sketch now reads its constants from
  `config.h`; keep the bus at 100 kHz until a bus scan proves otherwise.
- The bus has gone silent three times on 11 Oct 2026, each time after the wiring was
  handled. Long-term fix: solder or lock the sensor VCC/GND rather than Dupont.
- An INA226 that reports 0 A is usually a **shunt calibration** fault, not a dead
  sensor. Confirm the bus answers before suspecting hardware.
