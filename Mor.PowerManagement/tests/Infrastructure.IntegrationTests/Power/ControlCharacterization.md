# Control characterization (PLAN-0001 S0001.2a, Spec B)

Executable characterization of the control path at baseline `54c4885`, plus only
the deterministic clock seams. These tests lock what the code **does today**,
including surprising behavior. Where documentation disagrees, the code is the
reference and the disagreement is listed below. Nothing here proves physical relay
operation or autonomous firmware protection; it covers backend behavior only.

Later slices (D, E) must keep these tests passing unchanged. **Do not rewrite an
expected decision to fit a change.** A failing characterization test means the
change altered control behavior.

## Running

From `Mor.PowerManagement/` (PowerShell):

```powershell
$env:PATH = 'C:\Program Files\dotnet;' + $env:PATH
$env:ASPNETCORE_ENVIRONMENT = 'Development'
# Local throwaway Docker PostgreSQL 18 (container mor-test-pg); test-only credentials.
$env:MOR_TEST_DB_CONNECTION = 'Host=127.0.0.1;Port=55432;Username=<test user>;Password=<test password>;Database=<test db>'

dotnet test tests/Domain.UnitTests/Domain.UnitTests.csproj --filter "FullyQualifiedName~Characterization"
dotnet test tests/Infrastructure.IntegrationTests/Infrastructure.IntegrationTests.csproj --filter "FullyQualifiedName~ControlCharacterization"
```

Never point `MOR_TEST_DB_CONNECTION` at Neon, LoadWise or production. The harness
refuses non-loopback hosts.

## What is in the suite

| File | Contents |
|---|---|
| `tests/Domain.UnitTests/Power/LoadResponseCharacterizationTests.cs` | Total load, system-state boundaries, activation and allowance assessment |
| `tests/Domain.UnitTests/Power/LoadSheddingCharacterizationTests.cs` | Shed/restore ordering, protection, overload timers, sensor fault, manual override, unsheddable alarm, recovery |
| `tests/Infrastructure.IntegrationTests/Power/ControlCharacterizationTests.cs` | Real handlers (`IngestTelemetry`, manual on/off, clear recovery, ack fault, staged restoration, selective response, manual override) against PostgreSQL |
| `.../Power/Support/PostgresFixture.cs` | Standalone PostgreSQL harness (reused by later slices) |
| `.../Power/Support/ControlScenarioRunner.cs` | Scenario adapter: seeds, runs handlers, captures normalized traces |
| `.../Power/Support/ControlledTimeProvider.cs` (and the Application.UnitTests copy) | Manually advanced `TimeProvider`; no test sleeps |

Counts at this commit: Domain 48 (6 pre-existing + 42 characterization),
Application 8 (unchanged), Infrastructure integration 39 (all `ControlCharacterization`).

### Clock seams (the only production edits)

Each Power command handler that read `DateTimeOffset.UtcNow` now takes the
already-registered `TimeProvider` (registered as `TimeProvider.System` in
`src/Infrastructure/DependencyInjection.cs`) and calls `GetUtcNow()` at the same
place. The number and placement of clock reads did not change: `IngestTelemetry`,
`ApplySelectiveResponse`, `RunStagedRestoration`, `SetManualOverride`,
`RequestOutletActivation` read once into `now`; `DisconnectOutlet` reads twice
(command time, event time); `AcknowledgeOutletFault`, `ClearOutletRecoveryState`,
`UpdateOutletPolicy`, `UpdateThresholds` read once for the event timestamp. No
waits, thresholds, branches or refactoring were added. The domain engine never
reads a clock; its tests pass explicit timestamps.

## PostgreSQL harness

`PostgresFixture.CreateAsync()`:

1. Reads `MOR_TEST_DB_CONNECTION`. If it is unset, malformed, non-loopback, or the
   server cannot be opened, the fixture **throws**: missing infrastructure is a
   failure, never a skip. Exception text names only host:port/database, never the
   connection string or password.
2. Creates a unique schema `mor_ct_<yyyyMMddHHmmss>_<8 hex>` and refuses to reuse
   an existing one. Every destructive statement first checks the name against
   `^mor_ct_[0-9]{14}_[0-9a-f]{8}$`.
3. **Before migrating**, proves the scoped connection resolves only to that schema:
   `current_schema()` equals it, `current_schemas(false)` is exactly `[it]`, and it
   holds zero relations. It also snapshots every relation outside `mor_ct_*`.
4. Migrates with `__EFMigrationsHistory` pinned to the schema, and checks that the
   applied list equals the assembly's migration list.
5. **After migrating**, checks that the required tables exist in the schema and that
   the raw-SQL objects (`TelemetryReadingRollups`, `IX_TelemetryReadings_Timestamp_brin`)
   resolve to it, then checks that the outside-relation snapshot is unchanged.
6. `ResetAsync()` truncates only the schema's own tables, schema-qualified, without
   CASCADE, and keeps the migration history. `DisposeAsync()` drops only that schema.

It never starts Aspire or the web host, never runs `ApplicationDbContextInitialiser`
(the seeder), and never calls `EnsureDeleted`. `SchemaIsolation_MigrationsAndTeardownStayInsideOwnedSchema`
creates a second fixture, checks it is distinct, disposes it, and asserts that its
schema is gone, the first schema survives, and nothing outside `mor_ct_*` changed.
Isolation evidence from that run:

```
created schema mor_ct_<timestamp>_<id> on 127.0.0.1:55432/<db>
pre-migration: current_schema()=mor_ct_…; current_schemas(false)=[mor_ct_…]; relations in schema=0
post-migration: <n> tables in mor_ct_… (incl. __EFMigrationsHistory with <m> rows); raw-SQL TelemetryReadingRollups and BRIN index resolve to mor_ct_…
outside-schema relation inventory unchanged by migration (<k> relations)
```

The scenario seed is synthetic: one default `PowerSystemConfig` (P_limit 1300 W,
warning 1040 W) and outlets 1–5 at 2000 W allowance. Outlet 5 is deliberately the
`MonitoredOnlyOutletId` monitor row so the INA226 mirror path runs.

## Replay traces

`ControlScenarioRunner` records one JSON line per action (ingest, manual command,
restoration). Each line has the clock time, the command input, the returned
result (action, outlet, total, system state, events raised), the full in-memory
framework state (counters, timestamps, shed ledger, flags), every outlet's
persisted control fields (status, desired/pending command id, relay state, origin,
issued/acknowledged times, review flag, recovery episode, next-recovery time,
trial counters, holds, lockout), the config row, every persisted event in id
order, and the telemetry/INA row counts.

GUIDs are replaced by `guid-N` in first-seen order across the whole run, including
GUIDs embedded in event text. Equal GUIDs keep the same symbol, so ordering and
command-replacement assertions still hold.
`ReplayTrace_IsDeterministicAndRetainsGuidIdentityAndEventOrder` replays the same
scenario twice on fresh seeds and asserts byte-identical traces.

Every test writes its full trace to
`artifacts/bin/Infrastructure.IntegrationTests/debug/control-traces/<TestName>.jsonl`
and attaches it to the NUnit result. D and E differential tests should drive the
same inputs through `ControlScenarioRunner` and compare against these traces.

### Reference scenario: confirmed overload → shed → wrong ack → matching ack → post-settle clear

Condensed from `ReplayTrace_IsDeterministicAndRetainsGuidIdentityAndEventOrder`
(outlet 1 = Low priority, everything else 0 W):

| # | t (UTC) | Input | Result | Framework | Outlet 1 after | Events |
|---|---|---|---|---|---|---|
| 1 | 12:00:00.000 | seq 1, O1 = 1400 W | None, total 1400, Critical, "sustained for 0.0/3 s" | overLimit=1, since 12:00:00 | Active | 1 `System state: Critical` |
| 2 | 12:00:03.000 | seq 2, O1 = 1400 W | **Shed O1**, total recomputed to **0**, Normal | overLimit=2, ledger [O1 Nonessential 1400 W @12:00:03] | Disconnected; pending `guid-3` (open, `automatic-shed`), episode `guid-2`, NextRecovery 12:00:58 | +2 `Priority-based load shed` |
| 3 | 12:00:03.000 | seq 3, relay open, **wrong id** `guid-4` | None, "Waiting for the matching relay acknowledgement…" | unchanged | pending `guid-3`, **ack time null** | — |
| 4 | 12:00:03.000 | seq 4, relay open, id `guid-3` | None, same wait text | unchanged | **ack 12:00:03.000** | — |
| 5 | 12:00:03.501 | seq 5, relay open, id `guid-3` | None, "Timed recovery wait: 0/55 s" | counters reset; BelowRecoverySince 12:00:03.501 | pending cleared; NextRecovery moved to 12:00:58.501 | — |

Telemetry rows grow by 5 per accepted acquisition (20 → 25); no INA rows.

The full trace for steps 1–5 is the first five lines of
`control-traces/ReplayTrace_IsDeterministicAndRetainsGuidIdentityAndEventOrder.jsonl`,
reproduced verbatim at the end of this file.

## Named cases

All named cases from the spec are implemented under these exact names, with
boundary variants as `[TestCase]` rows.

Domain: `TotalLoad_ExcludesMonitorAndNonEnergizedOutlets`,
`SystemState_UsesInclusiveWarningAndCriticalBoundaries`,
`Activation_AllowsExactSystemLimit_BlocksAboveLimit`,
`OutletAllowanceAssessment_PreservesExistingBoundary`,
`ShedSelection_UsesTierThenDescendingWattsThenId`,
`ShedSelection_ExcludesProtectedAndMonitorOutlets`,
`CriticalPriorityAlone_DoesNotImplyProtection`,
`OutletAllowanceTrip_UsesFirstFreshAtOrAboveAllowance`,
`SystemOverload_RequiresThreeElapsedSeconds`,
`OverloadGap_AtSixSecondsContinues_AboveSixRestarts`,
`BackwardSampleTime_RestartsOverloadConfirmation`,
`SensorFault_PrecedesSheddingAndLatchesAlarm`,
`ManualOverride_SuppressesAutomaticSwitching`,
`UnsheddableOverload_AlarmsWithoutAssumingSafety`,
`Recovery_UsesExistingHysteresisBoundaryAnd55SecondWait`,
`Recovery_UsesFiveSecondReconnectSpacingAndExistingOrder`.
Extra: `Activation_ReasonTextIsStable`,
`OutletAllowanceAssessment_ExemptListBypassesCap_ButNoOutletIsExemptToday`,
`SystemOverload_RequiresThreeElapsedSeconds_ExactBoundaryAndEquality`,
`SensorFault_StalenessOnlyFaultsAboveLimit_AndLatchClearsOnNextCleanBatch`,
`Recovery_OverLimitSampleRestartsRecoveryWait`.

Handlers and persistence: `DuplicateOrOlderAcquisition_DoesNotStoreOrAdvanceControl`,
`NewAcquisitionSession_PreservesExistingAcceptance`,
`LegacyAcquisition_MonitorsWithoutAutomaticSwitching`,
`UnknownOutletReadings_AreIgnoredWithoutDroppingKnownOrIna`,
`InaPartialAndEmptyReports_PreserveExistingStorageAndMirror`,
`FaultFlag_RestrictsOutletsAndSkipsFramework`,
`RestrictedOutlet_RemainsRestrictedAfterRelayReport`,
`RelayOpenReport_PreservesExisting60SecondGrace`,
`Ack_RequiresMatchingCommandIdAndRelayState`,
`RepeatedMatchingAck_PreservesFirstAcknowledgementTime`,
`PendingCommand_ClearsOnlyAfterAllRequiredPostSettleSamples`,
`MissingAck_AfterFiveSeconds_EmitsReviewOnceAndPauses`,
`PendingOrReviewCommand_BlocksFurtherAutomaticSwitching`,
`MissingOrStaleInputs_PauseAutomaticSwitching`,
`RecoveryTrial_UsesThreeFreshOverLimitAcquisitions`,
`RecoveryTrial_ReopensSameOutlet_AndLocksOutAfterFifthAttempt`,
`ManualCommands_PreservePendingHoldAndClearanceRules`,
`ForcedRestoration_SkipsWaitsButPreservesExistingSafetyChecks`,
`WarningEvent_UsesLatestGlobalEventAndFiveMinuteBoundary`,
`EnergyValues_AreStoredWithoutIntegrationOrReinterpretation`.
Extra: `SchemaIsolation_MigrationsAndTeardownStayInsideOwnedSchema`,
`SelectiveResponse_UsesOneCandidateAndManualHoldDespiteCount`,
`ReplayTrace_IsDeterministicAndRetainsGuidIdentityAndEventOrder`.

### Key boundaries locked

| Behavior | Locked value |
|---|---|
| System state | Warning ≥ 1040 W, Critical ≥ 1300 W (both inclusive) |
| Activation | allowed when `P_total + allowance ≤ P_limit`; blocked at +0.001 W |
| Overload confirmation | shed on the first sample with ≥ 3.000 s elapsed since the first over-limit sample (`P_total ≥ P_limit`, equality counts) |
| Overload sample gap | gap of 6.000 s continues; 6.001 s restarts; a backward timestamp restarts |
| Outlet allowance trip | first fresh reading **at or above** allowance, 1 batch, any priority |
| Freshness | `LastSeen` 30.000 s old is fresh; 30.001 s or null is stale |
| Recovery | 55 s wait; the 1170 W hysteresis limit is reported but does not gate restore |
| Reconnect spacing | 5.000 s gate (4.999 s blocked) |
| Relay-open grace | 60.000 s after `CommandedAtUtc` stays Active; 60.001 s → Disconnected |
| Command ack | needs matching command id **and** matching relay state; first ack time is kept |
| Pending clear | needs every known outlet's `LastSeen` strictly after ack + 500 ms |
| Missing ack | review raised strictly after 5.000 s, one event only |
| Recovery trial | 3 fresh over-limit acquisitions (duplicates not counted); lockout on the 5th failed attempt |
| Warning event | repeated only when the latest event of any title differs or is > 5 min old |

## Sensitivity demonstration

Each mutation below was applied alone to production code, both characterization
suites were run, and the original file was restored byte-for-byte (verified with
`git status`). Script: `mutate.sh` in the worker scratchpad, not committed.

| Mutation | Change | Detected by (fails) |
|---|---|---|
| M1 wrong ack id accepted | `IngestTelemetry.cs`: `report.CommandId == pendingId` → `true` | `Ack_RequiresMatchingCommandIdAndRelayState(False,False,False)`, `MissingAck_AfterFiveSeconds_EmitsReviewOnceAndPauses` |
| M2a overload confirmation 3 s → 2 s | `OverLimitConfirmationSeconds` | 8 domain (`SystemOverload_*` ×5, `BackwardSampleTime_*`, `CriticalPriorityAlone_*`, `UnsheddableOverload_*`) + `ReplayTrace_*` |
| M2b overload gap 6 s → 7 s | `MaxOverLimitSampleGapSeconds` | `OverloadGap_AtSixSecondsContinues_AboveSixRestarts(6.001,False)` |
| M2c ack timeout 5 s → 6 s | `SwitchingResponseTimeoutSeconds` | `MissingAck_AfterFiveSeconds_EmitsReviewOnceAndPauses` |
| M2d recovery wait 55 s → 30 s | `RecoveryPeriodSeconds` | 7 domain (`Recovery_*` ×6, `ManualOverride_*`) + `RepeatedMatchingAck_*` |
| M3 shed order ascending watts | `LoadSheddingEngine.SelectNextShed`: `ThenByDescending(Watts)` → `ThenBy` | `ShedSelection_UsesTierThenDescendingWattsThenId`, `SelectiveResponse_UsesOneCandidateAndManualHoldDespiteCount` |
| M3b shed order ignores tier | `OrderByDescending(tier)` → `OrderBy(0)` | `ShedSelection_UsesTierThenDescendingWattsThenId` |

Unmutated baseline: Domain characterization 42/42, integration 39/39.

## Documentation/code discrepancies

The code is the reference. These are recorded, not repaired.

| # | Documentation says | Code does (locked by) |
|---|---|---|
| 1 | MUST_READ §2: an outlet above its allowance for **two consecutive** fresh readings opens | One fresh reading **at or above** allowance trips it (`OutletAllowanceConfirmationBatches = 1`; `OutletAllowanceTrip_UsesFirstFreshAtOrAboveAllowance`) |
| 2 | MUST_READ §2: restore after load stays **below 90 % of P_limit for 30 s** | Recovery wait is **55 s**, and the clock starts on the first non-overload batch whatever P_total is. The 1170 W limit is computed and reported but does not gate restore (`Recovery_UsesExistingHysteresisBoundaryAnd55SecondWait`) |
| 3 | MUST_READ §2: staged restores 5 s apart, four outlets in about 46 s | Each restore resets the recovery clock, so in a normal sequence the next outlet returns 56 s later, not 5 s. The 5 s gate only binds after a forced restoration (`Recovery_UsesFiveSecondReconnectSpacingAndExistingOrder`) |
| 4 | MUST_READ §3 FR-07: shed after **2 consecutive ticks**, `P_total > P_limit`; §2: "three-reading confirmation" | Shed when ≥ **3 s elapsed** between the first and current over-limit sample, `P_total ≥ P_limit`. That takes 4 samples at 1 Hz and 2 at 5 s cadence; gaps over 6 s restart (`SystemOverload_*`, `OverloadGap_*`) |
| 5 | FR-09: High/Critical are **never** shed candidates | Priority alone does not protect. Critical and High outlets are sheddable (last in order); only `IsProtected` excludes an outlet (`CriticalPriorityAlone_DoesNotImplyProtection`, `ShedSelection_*`) |
| 6 | FR-01: `S_fault` for **3 consecutive ticks** | One report with `faultFlag: true` restricts every outlet, sets `FaultHold`, and skips the framework (`FaultFlag_RestrictsOutletsAndSkipsFramework`) |
| 7 | FR-06: post-activation recheck sheds the **newest** activation first | No newest-first rule exists. Post-activation overload goes through the normal tier → watts → id ordering |
| 8 | MUST_READ §1: FR codes replace `POL-xx` everywhere | Activation verdicts still return `POL-02` / `POL-03`; the fault event text cites `POL-01` (`Activation_*`, `FaultFlag_*`) |
| 9 | MUST_READ §2: INA226 is never sent or stored as outlet 5; roster is outlets 1–4 | `MonitoredOnlyOutletId = 5` remains. When an outlet 5 row exists, INA reports are mirrored into its `CurrentWatts` and an outlet-5 telemetry row (power, else bus V × current) (`InaPartialAndEmptyReports_*`) |
| 10 | Firmware timing: §2 says 500 ms config poll, §4 says GET config every 15 000 ms | Backend-agnostic; noted only because traces assume no particular poll period |
| 11 | `ApplySelectiveResponse` accepts `Count` 1–5 | Only one candidate is shed per call regardless of `Count` (`SelectiveResponse_UsesOneCandidateAndManualHoldDespiteCount`) |

## Surprising behavior locked as-is

- After a shed, the returned total and system state are recomputed **excluding** the
  shed outlet before its relay has acknowledged, so the response shows 0 W / Normal
  in the same acquisition that measured 1400 W (reference trace, step 2).
- A repeated matching ACK keeps the first acknowledgement time but re-arms
  `NextRecoveryAtUtc` to now + 55 s on every repeat (`RepeatedMatchingAck_*`).
- An unsheddable overload raises an Alarm on **every** batch after confirmation and
  latches the fault; it is never treated as safe (`UnsheddableOverload_*`).
- A protected outlet's per-outlet over-allowance counter still advances; it is only
  excluded from selection.
- Warning/Critical state events are de-duplicated against the **latest event of
  any kind**, so an unrelated event (such as a manual override) in between makes
  the next warning repeat inside 5 minutes (`WarningEvent_*`).
- Legacy acquisitions (no session/sequence) are stored and monitored, but automatic
  switching is paused and the overload counter stays 0 (`LegacyAcquisition_*`).
- Sensor staleness only faults when the rig is above the limit; the latch clears
  on the next clean batch (`SensorFault_StalenessOnlyFaultsAboveLimit_*`).

## Coverage gaps (FR rules with no executable rule)

A seeded FR row or manuscript text does not show that a rule runs. These have no
executing code at `54c4885`, so nothing characterizes them:

| Rule | Status |
|---|---|
| FR-02 voltage window 198–264 V | Not implemented. Thresholds only appear in seed text. Readings carry voltage, but no rule evaluates it |
| FR-03 branch overcurrent `> 1.25 × rated amps` | Not implemented. `RatedVoltageVolts` exists, but no rated-amps rule runs. Only the plausibility bound `MaxPlausibleBranchWatts = 5000` (sensor fault) and the allowance trip apply |
| FR-05 schedule denial / denial `PowerEvent(Warning)` | `Outlet.Schedule` is stored and displayed but never evaluated. Activation checks allowance vs P_limit and holds/pending only |
| FR-06 newest-first post-activation shed | Not implemented as a distinct rule (see discrepancy 7) |
| FR-10 idle shed (≤ 80 W for 30 min) | Not implemented. `IdleLimitMinutes` only selects the `Standby` status label on a closed-relay report; nothing sheds on idle time |
| FR-11 calibration-due downgrade | Not implemented. Appears only in seed text |
| FR-12 rule audit row | No `RuleAuditRow` entity or table. Only `PowerEvent` rows are written |
| Firmware local FR-01/FR-07 | Out of scope. Backend tests cannot show firmware autonomy |

Other gaps in this suite: the dashboard/device-config queries, `UpdateOutletPolicy`
and `UpdateThresholds` behavior beyond their clock seam, authorization, and
concurrency between handler calls (the runner is sequential). The `TelemetryReadingRollups`
maintenance path is checked only for schema placement.

## Failed-commit publication defect (documented, not locked)

`IngestTelemetry`, `RunStagedRestoration`, `ApplySelectiveResponse` and
`SetManualOverride` publish the new framework state to the singleton
`LoadSheddingStateStore` (`_framework.Update`) **before** `SaveChangesAsync`. If the
commit fails, the in-memory counters, ledger and override flag have already moved
while the outlets and events were not persisted. The approved plan requires durable
changes to be published only after commit. No test makes this permanent. Tests
only cover successful commits, so D/E may fix the ordering without breaking this
suite. This is reported to the coordinator as a control defect; it is not repaired here.

## Reference trace (verbatim, steps 1–5)

```jsonl
{"label":"ingest","time":"2026-10-19T12:00:00+00:00","input":{"DeviceId":null,"AcquisitionSessionId":"guid-1","AcquisitionSequence":1,"FaultFlag":false,"MeteringMode":null,"Readings":[{"OutletId":1,"Voltage":238,"CurrentAmps":5.882352941176471,"PowerWatts":1400,"EnergyKwh":12.345},{"OutletId":2,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":3,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":4,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":5,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345}],"RelayStates":[],"Ina":null},"result":{"TotalWatts":1400,"State":2,"ReadingsStored":5,"EventsRaised":["System state: Critical"],"Shedding":{"Action":"None","OutletId":null,"OutletName":null,"Tier":null,"Detail":"P_total 1400.0 W is at or above P_limit 1300.0 W; sustained for 0.0/3 s.","PLimitWatts":1300,"RecoveryLimitWatts":1170,"ConsecutiveOverLimitBatches":1,"OverLimitConfirmationSeconds":3,"RecoveryPeriodSeconds":55,"ShedOutletIds":[],"ManualOverride":false,"FaultLatched":false}},"framework":{"ConsecutiveOverLimitBatches":1,"OverLimitSinceUtc":"2026-10-19T12:00:00+00:00","LastOverLimitSampleUtc":"2026-10-19T12:00:00+00:00","ConsecutiveOutletOverLimitBatches":{"1":0,"2":0,"3":0,"4":0,"5":0},"ShedLedger":[],"BelowRecoveryLimitSinceUtc":null,"LastReconnectUtc":null,"ManualOverride":false,"FaultLatched":false},"outlets":[{"Id":1,"Status":0,"CurrentWatts":1400,"LastSeen":"2026-10-19T12:00:00+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":2,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:00+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":3,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:00+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":4,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:00+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":5,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:00+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false}],"config":{"MaxCapacityWatts":1300,"WarningThresholdWatts":1040,"CriticalThresholdWatts":1300,"StandbyThresholdWatts":80,"StandbyIdleMinutes":30,"StabilizationDelayMs":500,"AutomaticPrioritisationEnabled":true,"LastAcquisitionSessionId":"guid-1","LastAcquisitionSequence":1,"MeteringMode":0,"MeteringModeUpdatedAt":null,"ZmctCtRatio":1000,"ZmctBurdenOhms":100,"ZmctPowerFactor":0.9,"ZmctGain":1,"Created":"0001-01-01T00:00:00+00:00","CreatedBy":null,"LastModified":"0001-01-01T00:00:00+00:00","LastModifiedBy":null,"Id":1,"DomainEvents":[]},"events":[{"Id":1,"Timestamp":"2026-10-19T12:00:00+00:00","Title":"System state: Critical","Detail":"P_total 1400 W crossed the configured threshold.","Severity":3}],"telemetry":5,"ina":0}
{"label":"ingest","time":"2026-10-19T12:00:03+00:00","input":{"DeviceId":null,"AcquisitionSessionId":"guid-1","AcquisitionSequence":2,"FaultFlag":false,"MeteringMode":null,"Readings":[{"OutletId":1,"Voltage":238,"CurrentAmps":5.882352941176471,"PowerWatts":1400,"EnergyKwh":12.345},{"OutletId":2,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":3,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":4,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":5,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345}],"RelayStates":[],"Ina":null},"result":{"TotalWatts":0,"State":0,"ReadingsStored":5,"EventsRaised":["Priority-based load shed"],"Shedding":{"Action":"Shed","OutletId":1,"OutletName":"Outlet 1","Tier":"Nonessential","Detail":"P_total 1400.0 W stayed at or above P_limit 1300.0 W for at least 3 s. Shedding Outlet 1 (Nonessential, 1400 W) as the most expendable active load.","PLimitWatts":1300,"RecoveryLimitWatts":1170,"ConsecutiveOverLimitBatches":2,"OverLimitConfirmationSeconds":3,"RecoveryPeriodSeconds":55,"ShedOutletIds":[1],"ManualOverride":false,"FaultLatched":false}},"framework":{"ConsecutiveOverLimitBatches":2,"OverLimitSinceUtc":"2026-10-19T12:00:00+00:00","LastOverLimitSampleUtc":"2026-10-19T12:00:03+00:00","ConsecutiveOutletOverLimitBatches":{"2":0,"3":0,"4":0,"5":0,"1":0},"ShedLedger":[{"OutletId":1,"Tier":4,"WattsAtShed":1400,"ShedAtUtc":"2026-10-19T12:00:03+00:00","OutletAllowanceTrip":false}],"BelowRecoveryLimitSinceUtc":null,"LastReconnectUtc":null,"ManualOverride":false,"FaultLatched":false},"outlets":[{"Id":1,"Status":3,"CurrentWatts":1400,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":"2026-10-19T12:00:03+00:00","ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":"guid-2","NextRecoveryAtUtc":"2026-10-19T12:00:58+00:00","RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":"guid-3","PendingRelayClosed":false,"PendingCommandOrigin":"automatic-shed","PendingCommandIssuedAtUtc":"2026-10-19T12:00:03+00:00","PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":2,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":3,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":4,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":5,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false}],"config":{"MaxCapacityWatts":1300,"WarningThresholdWatts":1040,"CriticalThresholdWatts":1300,"StandbyThresholdWatts":80,"StandbyIdleMinutes":30,"StabilizationDelayMs":500,"AutomaticPrioritisationEnabled":true,"LastAcquisitionSessionId":"guid-1","LastAcquisitionSequence":2,"MeteringMode":0,"MeteringModeUpdatedAt":null,"ZmctCtRatio":1000,"ZmctBurdenOhms":100,"ZmctPowerFactor":0.9,"ZmctGain":1,"Created":"0001-01-01T00:00:00+00:00","CreatedBy":null,"LastModified":"0001-01-01T00:00:00+00:00","LastModifiedBy":null,"Id":1,"DomainEvents":[]},"events":[{"Id":1,"Timestamp":"2026-10-19T12:00:00+00:00","Title":"System state: Critical","Detail":"P_total 1400 W crossed the configured threshold.","Severity":3},{"Id":2,"Timestamp":"2026-10-19T12:00:03+00:00","Title":"Priority-based load shed","Detail":"P_total 1400.0 W stayed at or above P_limit 1300.0 W for at least 3 s. Shedding Outlet 1 (Nonessential, 1400 W) as the most expendable active load.","Severity":2}],"telemetry":10,"ina":0}
{"label":"ingest","time":"2026-10-19T12:00:03+00:00","input":{"DeviceId":null,"AcquisitionSessionId":"guid-1","AcquisitionSequence":3,"FaultFlag":false,"MeteringMode":null,"Readings":[{"OutletId":1,"Voltage":238,"CurrentAmps":0.42016806722689076,"PowerWatts":100,"EnergyKwh":12.345},{"OutletId":2,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":3,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":4,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":5,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345}],"RelayStates":[{"OutletId":1,"RelayClosed":false,"CommandId":"guid-4"}],"Ina":null},"result":{"TotalWatts":0,"State":0,"ReadingsStored":5,"EventsRaised":[],"Shedding":{"Action":"None","OutletId":null,"OutletName":null,"Tier":null,"Detail":"Waiting for the matching relay acknowledgement and a fresh post-switch sample.","PLimitWatts":1300,"RecoveryLimitWatts":1170,"ConsecutiveOverLimitBatches":2,"OverLimitConfirmationSeconds":3,"RecoveryPeriodSeconds":55,"ShedOutletIds":[1],"ManualOverride":false,"FaultLatched":false}},"framework":{"ConsecutiveOverLimitBatches":2,"OverLimitSinceUtc":"2026-10-19T12:00:00+00:00","LastOverLimitSampleUtc":"2026-10-19T12:00:03+00:00","ConsecutiveOutletOverLimitBatches":{"2":0,"3":0,"4":0,"5":0,"1":0},"ShedLedger":[{"OutletId":1,"Tier":4,"WattsAtShed":1400,"ShedAtUtc":"2026-10-19T12:00:03+00:00","OutletAllowanceTrip":false}],"BelowRecoveryLimitSinceUtc":null,"LastReconnectUtc":null,"ManualOverride":false,"FaultLatched":false},"outlets":[{"Id":1,"Status":3,"CurrentWatts":100,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":"2026-10-19T12:00:03+00:00","ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":"guid-2","NextRecoveryAtUtc":"2026-10-19T12:00:58+00:00","RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":"guid-3","PendingRelayClosed":false,"PendingCommandOrigin":"automatic-shed","PendingCommandIssuedAtUtc":"2026-10-19T12:00:03+00:00","PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":2,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":3,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":4,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":5,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false}],"config":{"MaxCapacityWatts":1300,"WarningThresholdWatts":1040,"CriticalThresholdWatts":1300,"StandbyThresholdWatts":80,"StandbyIdleMinutes":30,"StabilizationDelayMs":500,"AutomaticPrioritisationEnabled":true,"LastAcquisitionSessionId":"guid-1","LastAcquisitionSequence":3,"MeteringMode":0,"MeteringModeUpdatedAt":null,"ZmctCtRatio":1000,"ZmctBurdenOhms":100,"ZmctPowerFactor":0.9,"ZmctGain":1,"Created":"0001-01-01T00:00:00+00:00","CreatedBy":null,"LastModified":"0001-01-01T00:00:00+00:00","LastModifiedBy":null,"Id":1,"DomainEvents":[]},"events":[{"Id":1,"Timestamp":"2026-10-19T12:00:00+00:00","Title":"System state: Critical","Detail":"P_total 1400 W crossed the configured threshold.","Severity":3},{"Id":2,"Timestamp":"2026-10-19T12:00:03+00:00","Title":"Priority-based load shed","Detail":"P_total 1400.0 W stayed at or above P_limit 1300.0 W for at least 3 s. Shedding Outlet 1 (Nonessential, 1400 W) as the most expendable active load.","Severity":2}],"telemetry":15,"ina":0}
{"label":"ingest","time":"2026-10-19T12:00:03+00:00","input":{"DeviceId":null,"AcquisitionSessionId":"guid-1","AcquisitionSequence":4,"FaultFlag":false,"MeteringMode":null,"Readings":[{"OutletId":1,"Voltage":238,"CurrentAmps":0.42016806722689076,"PowerWatts":100,"EnergyKwh":12.345},{"OutletId":2,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":3,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":4,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":5,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345}],"RelayStates":[{"OutletId":1,"RelayClosed":false,"CommandId":"guid-3"}],"Ina":null},"result":{"TotalWatts":0,"State":0,"ReadingsStored":5,"EventsRaised":[],"Shedding":{"Action":"None","OutletId":null,"OutletName":null,"Tier":null,"Detail":"Waiting for the matching relay acknowledgement and a fresh post-switch sample.","PLimitWatts":1300,"RecoveryLimitWatts":1170,"ConsecutiveOverLimitBatches":2,"OverLimitConfirmationSeconds":3,"RecoveryPeriodSeconds":55,"ShedOutletIds":[1],"ManualOverride":false,"FaultLatched":false}},"framework":{"ConsecutiveOverLimitBatches":2,"OverLimitSinceUtc":"2026-10-19T12:00:00+00:00","LastOverLimitSampleUtc":"2026-10-19T12:00:03+00:00","ConsecutiveOutletOverLimitBatches":{"2":0,"3":0,"4":0,"5":0,"1":0},"ShedLedger":[{"OutletId":1,"Tier":4,"WattsAtShed":1400,"ShedAtUtc":"2026-10-19T12:00:03+00:00","OutletAllowanceTrip":false}],"BelowRecoveryLimitSinceUtc":null,"LastReconnectUtc":null,"ManualOverride":false,"FaultLatched":false},"outlets":[{"Id":1,"Status":3,"CurrentWatts":100,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":"2026-10-19T12:00:03+00:00","ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":"guid-2","NextRecoveryAtUtc":"2026-10-19T12:00:58+00:00","RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":"guid-3","PendingRelayClosed":false,"PendingCommandOrigin":"automatic-shed","PendingCommandIssuedAtUtc":"2026-10-19T12:00:03+00:00","PendingCommandAcknowledgedAtUtc":"2026-10-19T12:00:03+00:00","CommandNeedsReview":false},{"Id":2,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":3,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":4,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":5,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false}],"config":{"MaxCapacityWatts":1300,"WarningThresholdWatts":1040,"CriticalThresholdWatts":1300,"StandbyThresholdWatts":80,"StandbyIdleMinutes":30,"StabilizationDelayMs":500,"AutomaticPrioritisationEnabled":true,"LastAcquisitionSessionId":"guid-1","LastAcquisitionSequence":4,"MeteringMode":0,"MeteringModeUpdatedAt":null,"ZmctCtRatio":1000,"ZmctBurdenOhms":100,"ZmctPowerFactor":0.9,"ZmctGain":1,"Created":"0001-01-01T00:00:00+00:00","CreatedBy":null,"LastModified":"0001-01-01T00:00:00+00:00","LastModifiedBy":null,"Id":1,"DomainEvents":[]},"events":[{"Id":1,"Timestamp":"2026-10-19T12:00:00+00:00","Title":"System state: Critical","Detail":"P_total 1400 W crossed the configured threshold.","Severity":3},{"Id":2,"Timestamp":"2026-10-19T12:00:03+00:00","Title":"Priority-based load shed","Detail":"P_total 1400.0 W stayed at or above P_limit 1300.0 W for at least 3 s. Shedding Outlet 1 (Nonessential, 1400 W) as the most expendable active load.","Severity":2}],"telemetry":20,"ina":0}
{"label":"ingest","time":"2026-10-19T12:00:03.501+00:00","input":{"DeviceId":null,"AcquisitionSessionId":"guid-1","AcquisitionSequence":5,"FaultFlag":false,"MeteringMode":null,"Readings":[{"OutletId":1,"Voltage":238,"CurrentAmps":0.42016806722689076,"PowerWatts":100,"EnergyKwh":12.345},{"OutletId":2,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":3,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":4,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345},{"OutletId":5,"Voltage":238,"CurrentAmps":0,"PowerWatts":0,"EnergyKwh":12.345}],"RelayStates":[{"OutletId":1,"RelayClosed":false,"CommandId":"guid-3"}],"Ina":null},"result":{"TotalWatts":0,"State":0,"ReadingsStored":5,"EventsRaised":[],"Shedding":{"Action":"None","OutletId":null,"OutletName":null,"Tier":null,"Detail":"Timed recovery wait: 0/55 s; holding shed branches.","PLimitWatts":1300,"RecoveryLimitWatts":1170,"ConsecutiveOverLimitBatches":0,"OverLimitConfirmationSeconds":3,"RecoveryPeriodSeconds":55,"ShedOutletIds":[1],"ManualOverride":false,"FaultLatched":false}},"framework":{"ConsecutiveOverLimitBatches":0,"OverLimitSinceUtc":null,"LastOverLimitSampleUtc":null,"ConsecutiveOutletOverLimitBatches":{"2":0,"3":0,"4":0,"5":0,"1":0},"ShedLedger":[{"OutletId":1,"Tier":4,"WattsAtShed":1400,"ShedAtUtc":"2026-10-19T12:00:03+00:00","OutletAllowanceTrip":false}],"BelowRecoveryLimitSinceUtc":"2026-10-19T12:00:03.501+00:00","LastReconnectUtc":null,"ManualOverride":false,"FaultLatched":false},"outlets":[{"Id":1,"Status":3,"CurrentWatts":100,"LastSeen":"2026-10-19T12:00:03.501+00:00","CommandedAtUtc":"2026-10-19T12:00:03+00:00","ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":"guid-2","NextRecoveryAtUtc":"2026-10-19T12:00:58.501+00:00","RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":2,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03.501+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":3,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03.501+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":4,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03.501+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false},{"Id":5,"Status":0,"CurrentWatts":0,"LastSeen":"2026-10-19T12:00:03.501+00:00","CommandedAtUtc":null,"ManualHold":false,"FaultHold":false,"RecoveryLockout":false,"AutomaticRecoveryAttempts":0,"RecoveryEpisodeId":null,"NextRecoveryAtUtc":null,"RecoveryTrialPending":false,"RecoveryTrialOverLimitBatches":0,"PendingCommandId":null,"PendingRelayClosed":null,"PendingCommandOrigin":null,"PendingCommandIssuedAtUtc":null,"PendingCommandAcknowledgedAtUtc":null,"CommandNeedsReview":false}],"config":{"MaxCapacityWatts":1300,"WarningThresholdWatts":1040,"CriticalThresholdWatts":1300,"StandbyThresholdWatts":80,"StandbyIdleMinutes":30,"StabilizationDelayMs":500,"AutomaticPrioritisationEnabled":true,"LastAcquisitionSessionId":"guid-1","LastAcquisitionSequence":5,"MeteringMode":0,"MeteringModeUpdatedAt":null,"ZmctCtRatio":1000,"ZmctBurdenOhms":100,"ZmctPowerFactor":0.9,"ZmctGain":1,"Created":"0001-01-01T00:00:00+00:00","CreatedBy":null,"LastModified":"0001-01-01T00:00:00+00:00","LastModifiedBy":null,"Id":1,"DomainEvents":[]},"events":[{"Id":1,"Timestamp":"2026-10-19T12:00:00+00:00","Title":"System state: Critical","Detail":"P_total 1400 W crossed the configured threshold.","Severity":3},{"Id":2,"Timestamp":"2026-10-19T12:00:03+00:00","Title":"Priority-based load shed","Detail":"P_total 1400.0 W stayed at or above P_limit 1300.0 W for at least 3 s. Shedding Outlet 1 (Nonessential, 1400 W) as the most expendable active load.","Severity":2}],"telemetry":25,"ina":0}
```
