# MOR Power Management — Backend Schema and Testing Reference

Purpose: everything a tester needs to exercise the backend and the dashboard, in
one place. Every table, column, enum and constraint below was read from the
committed EF Core model snapshot and the generated OpenAPI document, not written
from memory. Where a number is an estimate rather than a measurement, it says so.

- Snapshot: `src/Infrastructure/Data/Migrations/ApplicationDbContextModelSnapshot.cs`
- OpenAPI: `src/Web/wwwroot/openapi/v1.json`
- Enums: `src/Domain/Enums/*.cs`
- Live host: `https://mor-powermanagement.onrender.com`

---

## 1. Database

PostgreSQL on Neon (`ap-southeast-1`). Migrations are applied at startup by
`ApplicationDbContextInitialiser`. Raw telemetry is retained for **6 hours** by
default (`Telemetry:RawRetentionHours`). Older readings are summarized into
five-minute outlet rollups and retained for **30 days**
(`Telemetry:RollupRetentionDays`).

### 1.1 `Outlets` — the channel roster

One row per controllable branch. Seeded with 13 rows.

| Column | Type | Null | Notes |
|---|---|---|---|
| `Id` | `integer` | no | PK, identity. Also the telemetry channel id (CH1..CH13). |
| `Name` | `varchar(100)` | no | e.g. `Outlet 1`, `USB 4`. |
| `Role` | `varchar(200)` | no | Free-text function of the branch. |
| `MeterChannel` | `varchar(100)` | no | PZEM-004T v3.0 on the common mains feed. |
| `RelayChannel` | `varchar(100)` | no | ESP32 GPIO label, e.g. `GPIO4`. |
| `Priority` | `integer` | no | `OutletPriority` enum. See 2.2. |
| `AllowanceWatts` | `double precision` | no | Budget for this branch. Drives POL-05/06 shed order. |
| `RatedVoltageVolts` | `integer` | no | 220 mains, 110 step-down, or 5 for USB. |
| `Status` | `integer` | no | `OutletStatus` enum. See 2.3. |
| `CurrentWatts` | `double precision` | no | Latest known draw, refreshed on ingest. |
| `IdleLimitMinutes` | `integer` | **yes** | `NULL` = exempt from the POL-08 idle shutdown. |
| `Schedule` | `varchar(200)` | no | Free text. Displayed only; not evaluated. |
| `LastSeen` | `timestamptz` | **yes** | Null until the device reports. |
| `CommandedAtUtc` | `timestamptz` | **yes** | Last commanded relay change. |
| `Created` / `LastModified` | `timestamptz` | no | Audit columns. |
| `CreatedBy` / `LastModifiedBy` | `text` | **yes** | Audit columns. |

### 1.2 `TelemetryReadings` — the time series

Recent raw samples. Short chart windows read this table; old readings are moved
into `TelemetryReadingRollups` after the raw retention window.

| Column | Type | Notes |
|---|---|---|
| `Id` | `integer` | PK, identity. |
| `OutletId` | `integer` | FK -> `Outlets.Id`. |
| `Timestamp` | `timestamptz` | Sample time. |
| `Voltage` | `double precision` | Derived per branch except the 220 V mains reading. |
| `CurrentAmps` | `double precision` | Derived as P / V. Not independently sampled. |
| `PowerWatts` | `double precision` | Allowance-weighted share of the measured mains total. |
| `EnergyKwh` | `double precision` | Cumulative device-side counter. |

Indexes:
- `IX_TelemetryReadings_Timestamp_brin` — BRIN on `Timestamp`, for the
  time-ordered range scans every chart window performs.
- `(OutletId, Timestamp)` — composite, for per-channel pivots.

### 1.3 `TelemetryReadingRollups` — long-term chart history

One row per outlet per five-minute bucket. The retention worker summarizes and
deletes each bounded batch in one database statement, so interrupted cleanup
cannot lose readings between those steps. The 24-hour and 7-day chart windows
combine rollups with recent raw readings.

Each row stores sample counts and sums for weighted averages, minimum and
maximum voltage, peak watts, and first/last energy-counter values.

**Bucket alignment.** `GetTelemetrySeries.DateBin` floors to the bucket using
`value.UtcTicks - BinEpoch.Ticks` before the modulo. `date_bin`'s origin is
2001-01-01, so flooring raw ticks and adding them to the epoch overshoots by
~2025 years. This was the cause of the "year 4026" empty-chart bug; a regression
test should assert the returned `from`/`to` are near the present.

### 1.4 `PowerSystemConfigs` — thresholds and provenance

Expected to be a single row. `UpdateThresholdsCommand` creates one if absent.

| Column | Type | Notes |
|---|---|---|
| `Id` | `integer` | PK, identity. |
| `MaxCapacityWatts` | `double precision` | P_limit for POL-02..POL-07. |
| `WarningThresholdWatts` | `double precision` | Must be **<** critical. |
| `CriticalThresholdWatts` | `double precision` | P_limit driving deny/shed. |
| `StandbyThresholdWatts` | `double precision` | POL-08 branch threshold. `>= 0`. |
| `StandbyIdleMinutes` | `integer` | POL-08 idle duration. `>= 0`. |
| `StabilizationDelayMs` | `integer` | Post-activation delay. `>= 0`. |
| `MeteringMode` | `integer` | `MeteringMode` enum. See 2.4. |
| `MeteringModeUpdatedAt` | `timestamptz` | When the device last declared its mode. |
| `Created` / `LastModified` | `timestamptz` | Audit. |
| `CreatedBy` / `LastModifiedBy` | `text` | Audit, nullable. |

`StandbyIdleMinutes` and `StabilizationDelayMs` were added to the read DTO so the
admin form can round-trip them; before that the form could write a value it
could never read back.

#### Live threshold values, and where they come from

**The database row is authoritative at runtime. The C# entity defaults are not.**
`PowerSystemConfig` declares fallback defaults (2200 / 1800 / 2000 / 80), but
those only apply when **no** row exists. Once a row exists — written by the
seeder on first boot, or edited later through Policy Admin — the row wins, and
the entity defaults are never consulted again.

Current deployed values, read from `GET /api/Dashboard/state`:

| Field | Live value | Share of capacity |
|---|---|---|
| `MaxCapacityWatts` | 4000 W | 100 % (P_limit) |
| `WarningThresholdWatts` | 3240 W | 81 % |
| `CriticalThresholdWatts` | 3600 W | 90 % (drives POL-03 / POL-04) |
| `StandbyThresholdWatts` | 80 W | POL-08 branch threshold |
| `StandbyIdleMinutes` | 30 min | POL-08 idle duration |
| `StabilizationDelayMs` | 500 ms | post-activation delay |

So any prose quoting "2200 W" or "2500 W" is wrong. The dashboard reads these
from the API rather than hardcoding them, which is why the Policy Admin stat
strip and the Channel Inventory capacity figures track an edit immediately.

To verify on a running host:

```powershell
curl.exe -s -H "Cookie: .AspNetCore.Identity.Application=<cookie>" \
  http://localhost:5299/api/Dashboard/state | ConvertFrom-Json | Select-Object -Expand thresholds
```

**Who can change them.** `PUT /api/Dashboard/thresholds` (any signed-in user —
there is no role check on the Dashboard group) and the ESP32, which pulls them
via `GET /api/Device/config` every `CONFIG_INTERVAL_MS` (15 s) and caches them
in NVS. A policy edit therefore reaches the relays within ~15 s, and persists
across a network drop.

### 1.4 `PowerEvents` — the audit trail

| Column | Type | Notes |
|---|---|---|
| `Id` | `integer` | PK, identity. |
| `Timestamp` | `timestamptz` | Indexed. |
| `Title` | `varchar(200)` | Short event name. |
| `Detail` | `varchar(1000)` | Human-readable explanation. |
| `Severity` | `integer` | `EventSeverity` enum. See 2.5. |

### 1.5 `ControlPolicies` — POL-01..POL-08

`Id` (PK, identity), `Code` (`varchar(20)`), `Name` (`varchar(200)`),
`Condition` (`varchar(500)`), `Action` (`varchar(200)`), plus the `Created` /
`LastModified` audit columns. Served read-only by
`GET /api/Dashboard/policies`. There is no `Description` column; the
human-readable rationale lives in the client copy, not the database.

### 1.6 Scaffold tables still present

`TodoItems`, `TodoLists` and the ASP.NET Identity tables (`AspNetUsers`,
`AspNetRoles`, `AspNetUserClaims`, `AspNetUserLogins`, `AspNetUserRoles`,
`AspNetUserTokens`) come from the template this solution was scaffolded from.
The Identity tables are in use for dashboard login. The Todo tables are **not
part of the thesis** and are safe to ignore during testing.

---

## 2. Enumerations

All enums are stored as `integer` and are **transmitted as numbers**. No
`JsonStringEnumConverter` is registered, so sending `"Simulated"` where an enum
is expected fails to deserialize. This is an easy mistake to repeat.

### 2.1 `SystemState`
`0` Normal, `1` Warning, `2` Critical

### 2.2 `OutletPriority`
`1` Low, `2` Medium, `3` High, `4` Critical.
Low is shed first; Critical is preserved last (POL-07).

### 2.3 `OutletStatus`
`0` Active, `1` Standby, `2` Restricted, `3` Disconnected.
Standby is still relay-energized and still counts as a load channel.

### 2.4 `MeteringMode`
`0` Unknown, `1` Simulated, `2` Metered.

`Unknown` is the default for rows written before the device reported a mode.
With `SIMULATE_METERS=1` on the firmware every reading is synthesised, so the
dashboard must never present a value as measured. The provenance badges and the
banner copy in the client are derived from this field.

### 2.5 `EventSeverity`
`0` Info, `1` Success, `2` Warning, `3` Critical

---

## 3. API surface

### 3.1 Dashboard routes (cookie auth, `RequireAuthorization`)

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/Dashboard/state` | Roster, live watts, totals, thresholds, recent events. |
| GET | `/api/Dashboard/telemetry` | Bucketed V/A/W series. Query: `window`, `channels`. |
| GET | `/api/Dashboard/policies` | POL-01..POL-08. |
| POST | `/api/Dashboard/outlets/{id}/activation` | Request a branch. POL-02 allow / POL-03 deny. |
| POST | `/api/Dashboard/outlets/{id}/disconnection` | Open a relay. |
| POST | `/api/Dashboard/shedding/selective` | POL-05 shed lowest priority first. Body: `{ count }`. |
| PUT | `/api/Dashboard/outlets/{id}/policy` | Partial update: priority, allowance, schedule, idle limit. |
| PUT | `/api/Dashboard/thresholds` | Partial update of the six threshold fields. |
| POST | `/api/Dashboard/scenarios/ingest` | Defense-demo batch. Forces `MeteringMode = Simulated`. |

### 3.2 Device routes (`X-Device-Key` when `Device:ApiKey` is configured)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/Device/telemetry` | ESP32 ingest. Stores readings, refreshes state, evaluates policies. |
| GET | `/api/Device/config` | Threshold + policy table for device sync. |

`DeviceApiKeyEndpointFilter` passes the request through when no key is
configured, which is what allows local and defense-demo use without a secret.
**On the deployed host a key is set**, so this route returns 401 without the
header. The dashboard therefore uses `/Dashboard/scenarios/ingest` instead and
never holds the key — shipping it in the bundle would let anyone who can read
the JavaScript inject readings.

### 3.3 Policy enforcement — where each rule actually runs

Documented because "which component enforces POL-xx" is a defensibility
question, and the honest answer is not uniform.

| Rule | ESP32 (on-device) | Backend | Notes |
|---|---|---|---|
| POL-01 fault isolation | Yes | Yes | Both trip `S_fault` / open all relays. |
| POL-02 pre-activation allow | Yes | Yes | |
| POL-03 pre-activation deny | Yes | Yes | |
| POL-04 post-activation shed | Yes | Yes | Uses `StabilizationDelayMs` (500 ms) as the settle window. |
| POL-05 / POL-06 shed by priority | Yes | Yes | Server endpoint `/Dashboard/shedding/selective`. |
| POL-07 priority preservation | Yes (via candidate ordering) | Yes | |
| **POL-08 standby / idle** | **Yes** | **Detection only** | See below. |

**POL-08 was previously enforced nowhere.** The firmware fetched
`standbyThresholdWatts` into `cfgStandby` and persisted it to NVS but never
evaluated it, and `LoadResponseEvaluator.DetectIdleCandidates` on the server had
no callers — dead code. The rule therefore existed as a policy row in the
database and a card in the Policies view, with nothing behind it.

It is now implemented on-device. A channel that is energized, not already shed
for capacity, and drawing at or below `StandbyThresholdWatts` has its idle timer
started; once that timer exceeds the channel's `IdleLimitMinutes` — or the
global `StandbyIdleMinutes` when the channel's own value is null — the relay is
opened and `POL-08` is logged to serial.

`null` `IdleLimitMinutes` means **exempt**, so it is stored as `-1` rather than
`0`: conflating the two would either shed deliberately-exempt channels or never
shed the ones that should be. A per-channel limit of `0` disables the timer for
that channel only.

Both inputs are persisted in NVS (`sbIdle`, `idleLim`) so the rule survives a
reboot with no network. On restore from a table written before this existed, the
compiled `-1` exempt defaults are kept — the safe direction, because an
unenforced standby rule only wastes power whereas a wrongly-enforced one would
shed channels the operator had exempted.

**Why the device rather than the server:** the ESP32 is the only component that
can act without a network round-trip, which is what the "enforces the last
synced policy when the network drops" property requires. Pol-08 is inherently a
*time-based* rule — it needs a timer running for 30 minutes — so delegating it to
a request/response backend would mean holding state across requests for no gain.

**Known gap:** `DetectIdleCandidates` remains uncalled on the server. It is
harmless dead code and may be wired to a future auto-shed endpoint, but it must
not be described as an active control.

---

## 4. Request contracts

### 4.1 `POST /api/Dashboard/scenarios/ingest`

```json
{
  "deviceId": "dashboard-scenario",
  "faultFlag": false,
  "readings": [
    { "outletId": 1, "voltage": 220.0, "currentAmps": 2.36, "powerWatts": 520, "energyKwh": 0.000144 }
  ],
  "relayStates": [ { "outletId": 1, "relayClosed": true } ]
}
```

Response:

```json
{
  "totalWatts": 1930.0,
  "state": 1,
  "readingsStored": 13,
  "eventsRaised": ["Warning threshold crossed"]
}
```

Server-side validation on each reading (`IngestTelemetryCommandValidator`):

| Field | Rule |
|---|---|
| `readings` | Must not be empty. |
| `outletId` | `> 0`. |
| `voltage` | 0 to 300 inclusive. |
| `currentAmps` | 0 to 100 inclusive. |
| `powerWatts` | 0 to 5000 inclusive. |
| `energyKwh` | `>= 0`. |

Note the 100 A ceiling: a 5 V USB rail drawing 500 W would derive to 100 A and
be rejected. The client clamps derived current to 100 for this reason.

### 4.2 `PUT /api/Dashboard/thresholds` — partial

Only the fields present are applied, so one value can be changed without
touching the others. Validation:

| Field | Rule |
|---|---|
| `maxCapacityWatts` | `> 0` |
| `warningThresholdWatts` | `> 0` |
| `criticalThresholdWatts` | `> 0` |
| `standbyThresholdWatts` | `>= 0` |
| `standbyIdleMinutes` | `>= 0` |
| `stabilizationDelayMs` | `>= 0` |
| cross-field | `warning < critical`, else: "Warning threshold must stay below the critical threshold (P_limit)." |

A cross-field check only fires when **both** values are in the same request. To
test it, send `warning` and `critical` together.

### 4.3 `PUT /api/Dashboard/outlets/{id}/policy` — partial

`outletId` in the URL must equal `outletId` in the body, else 400.

| Field | Rule |
|---|---|
| `outletId` | `> 0` |
| `priority` | `OutletPriority` integer 1-4 |
| `allowanceWatts` | `>= 0` |
| `schedule` | Max length 200 |
| `idleLimitMinutes` | `>= 0` |
| `clearIdleLimit` | `true` sets the outlet exempt (null). Wins over `idleLimitMinutes`. |

### 4.4 `GET /api/Dashboard/telemetry`

`window` is one of `15m`, `1h`, `6h`, `24h`, `7d`. `channels` is a
comma-separated id list; omit it for all 13. Series are capped at 168 points
each, so longer windows are downsampled. A `null` in an array is a **gap**
(relay open, or no sample in that bucket) and must never be rendered as `0`.

---

## 5. Test plan

### 5.1 Preconditions

- Connection string present (`ConnectionStrings:Mor.PowerManagementDb`).
- Migrations applied — they run on startup.
- `ASPNETCORE_ENVIRONMENT=Development` when running locally, otherwise
  user-secrets are not loaded and the app fails to reach the database.
- Recent raw telemetry is kept for 6 hours and older history is rolled up for
  30 days by default. Tests that need history must seed it; the rig
  cannot produce it in real time.

### 5.2 Smoke

1. `POST /api/Users/login` with valid credentials -> 200, empty body. This is
   documented Identity behaviour, not a bug.
2. `GET /api/Dashboard/state` -> outlets populated, `thresholds` includes
   `standbyIdleMinutes` and `stabilizationDelayMs`.
3. `GET /api/Dashboard/telemetry?window=1h` -> `rawSampleCount > 0` and
   `from`/`to` in the present year.
4. `GET /api/Dashboard/policies` -> eight entries, POL-01..POL-08.

### 5.3 Policy evaluation

| # | Action | Expected |
|---|---|---|
| 1 | Ingest a batch below the warning threshold | `state = 0`, no events |
| 2 | Ingest between warning and critical | `state = 1`, warning event |
| 3 | Ingest above critical | `state = 2`, critical event |
| 4 | `POST /shedding/selective` with `{count:2}` | two lowest-priority energized outlets disconnected; High/Critical preserved |
| 5 | Activation request with projected load over critical | denied, POL-03 |
| 6 | `faultFlag: true` | POL-01, all relays open, lockout set |
| 7 | Standby branch below threshold for the idle duration | POL-08 shed |

### 5.4 Administration

1. `PUT /thresholds` with one field -> only that field changes.
2. `PUT /thresholds` with `warning >= critical` -> rejected; the row is unchanged.
3. `PUT /outlets/{id}/policy` with `clearIdleLimit: true` -> `idleLimitMinutes`
   becomes null, dashboard shows "Exempt".
4. URL/body `outletId` mismatch -> 400.
5. Confirm the device picks up changes via `GET /api/Device/config`. A save
   confirmation means persisted, not that a relay has already moved — the
   ESP32 reads the config on its next cycle.

### 5.5 Defense scenarios

Each button in the Scenario panel now posts a real batch through
`/Dashboard/scenarios/ingest`. Verify:

1. Click **Post-activation overload**. The notice must report rows stored and
   the events the policy engine raised. Switch to Telemetry: the chart must
   move. If it does not, the write did not happen — the notice will say so.
2. Click **Selective response**. Two low-priority channels go to zero with
   relays reported open.
3. Click **Idle shutdown**. Total drops; standby channels go to zero.
4. With the backend stopped, click any button. The notice must read
   "backend unreachable ... No rows were stored" in the warning tone. It must
   not claim a shed occurred.
5. `readingsStored` must equal 13 for every scenario, and each reading must
   satisfy the validation table in 4.1.

### 5.6 Regression risks

- **Bucket alignment.** Assert telemetry `from`/`to` are near the present, not
  the year 4026. See 1.2.
- **Gap vs zero.** A null bucket is a gap. Assert that an open relay produces a
  break in the series, not a drop to 0 W.
- **Enum wire format.** Assert `priority` and `meteringMode` are sent as
  integers. See section 2.
- **Retention.** Recent telemetry remains raw for 6 hours, then the retention
  service moves it into five-minute summaries. Seven-day history needs seven
  days of accumulated summaries to become complete.

---

## 6. Known gaps

- The scenario panel drives only channel 6 by default (`overloadChannel`).
  Other channels can be nominated but the UI exposes no selector.
- `Schedule` is stored and displayed but no policy evaluates it.
- There is no endpoint to add, remove or reorder outlets.
- Restricted-state lockout has no explicit clear operation; it clears when a
  later batch reports healthy readings.
- The heatmap and 30-day statistics depend on a `TelemetryReadingsHourly`
  rollup table that does not exist yet.
