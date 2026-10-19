# Telemetry runtime snapshot (PLAN-0001 Spec D)

Serves device configuration and dashboard current state from memory, so polling
them does not query (or wake) the database. Introduced by PLAN-0001 slice
S0001.2 (Wave 2). Closes the read side of Neon wake sources W-05, W-07 and W-12
in `docs/NEON_WAKE_AUDIT.md`, and provides hydration and post-commit
publication for W-06/W-10.

Unit and integration evidence here proves backend behavior only. It does not
prove Neon suspension (G's gate), physical relay operation, or firmware
autonomy.

## Flag

| Key | Default | Effect |
|---|---|---|
| `Telemetry:CachedReadsEnabled` | `false` (also when absent) | Turns on everything in this document. |
| `Telemetry:SingleWriterLockDirectory` | process temp directory | Where the single-writer lock file lives. Only read when the flag is on. |

With the flag **off**, every path is the legacy one: each request queries the
database, the dashboard endpoint keeps its 5 s cache, mutations are not
serialized, the logging behaviours still look up the user name in
`AspNetUsers`, and the existing pre-commit framework publication (see
`tests/Infrastructure.IntegrationTests/Power/ControlCharacterization.md`) is
unchanged. No guard is taken and nothing is hydrated.

The only behavior-neutral change on the off path is the clock seam in
`GetDashboardStateQueryHandler`: its three `DateTimeOffset.UtcNow` reads now
call the registered `TimeProvider` (`TimeProvider.System` in the app), in the
same places.

Enable on the rehearsal destination only, first in the order of
`2026-10-19_2136_plan-0001-slice-specs.md` (cached reads, then runtime ingest,
batch persistence, retention/quiet mode). A code merge does not authorize
production rollout.

## What the snapshot holds

`PowerRuntimeSnapshot` (`src/Application/Power/Runtime/PowerRuntimeSnapshot.cs`)
is an immutable record. It contains copies only: no tracked entity, `DbContext`
or scope.

| Part | Content | Source |
|---|---|---|
| `ConfigVersion` / `LiveVersion` | `LiveVersion` +1 on every publication; `ConfigVersion` +1 only when thresholds/calibration or roster policy fields change | coordinator |
| `Config` | every `PowerSystemConfig` field; `null` when no row exists (readers then use the entity defaults, exactly like the legacy `?? new PowerSystemConfig()`) | hydration, commits |
| `Outlets` | every `Outlet` field: roster/policy, desired status, live watts/last seen, pending command, acknowledgement time, recovery and hold fields | hydration, commits |
| `Outlets[i].LastRelayReport` | the device's last relay report for that outlet (closed/open, command id, time). **Kept apart from** `PendingCommandAcknowledgedAtUtc`; a report only becomes an acknowledgement through the unchanged ingest rule (matching command id **and** relay state). Not persisted, so `null` after hydration. | ingest |
| `Framework` | the load-shedding `LoadSheddingState` (counters, ledger, override, fault latch) | in-memory store |
| `RecentEvents` | newest 20 events, ordered by timestamp then id (the dashboard shows 20; ingest's warning de-duplication needs only the newest) | hydration, commits |
| `LatestIna` | newest stored INA226 sample of any age | hydration, ingest |
| `VoltageWindow` | stored telemetry samples with voltage > 0 that can still fall inside a later 30 s cutoff | hydration, ingest |

Timestamps are truncated to microseconds and stored as UTC, the same values a
PostgreSQL `timestamptz` reload returns.

### Mains-voltage window

The legacy dashboard computes
`AVG(Voltage) FROM TelemetryReadings WHERE Timestamp >= now - 30 s AND Voltage > 0 AND OutletId IN (outlets rated >= 100 V)`.
`RuntimeVoltageWindow.Average` evaluates the same predicate over memory at the
request's clock. Bounds:

- On every publication, samples older than 30 s before the publication clock
  are dropped. Such a sample can never satisfy a later cutoff (the clock does
  not run backwards), so no later average changes.
- At most 16,384 samples are kept (oldest dropped first, counted in
  `DroppedForCapacity`). The rig's steady rate is about 13 channels × 1 Hz ×
  30 s = 390. Reaching the bound requires a burst far above the device rate;
  E adds request-size limits.

Floating-point sums may differ from PostgreSQL's in the last bits because rows
can be summed in a different order. The integration test compares within 1e-9.

## Hydration

- Five read-only queries (`src/Infrastructure/Power/PowerRuntimeHydrator.cs`):
  config row, all outlets, newest 20 events, voltage samples from the last
  30 s, newest INA sample. No tracking; the scope is disposed before the
  snapshot is published.
- Startup (`src/Web/Program.cs`, inside the *Startup* measurement scope): take
  the single-writer guard → `InitialiseDatabaseAsync` (migrations, seeder) →
  `HydratePowerRuntimeAsync`. `app.Run()` (and so request acceptance) starts
  only after hydration succeeded. A hydration failure stops startup.
  Build-time OpenAPI generation (`isDocGen`) skips all three.
- First use is single-flight: concurrent first readers share one hydration
  task, and a mutation that arrives first hydrates under the write gate, so
  hydration runs exactly once.
- Failure publishes nothing. Readers get `PowerRuntimeUnavailableException`
  (HTTP 500: the problem-details mapper does not handle it, so the default handler responds) rather than default state
  presented as synchronized. The next request may try again. There is no timer
  and no background retry.

## Read paths (flag on)

| Request | Handler | Database |
|---|---|---|
| `GET /api/Device/config` | `GetDeviceConfigQueryHandler.Project(snapshot)` | none |
| `GET /api/Dashboard/state` | `GetDashboardStateQueryHandler.Project(snapshot, now)` | none |

`Dashboard.GetState` bypasses its 5 s `IMemoryCache` entry when the flag is on;
the cache could only hide newly committed state. Routes, authorization and DTO
schemas are unchanged (the OpenAPI document shows no schema change from D).

Freshness is evaluated against `TimeProvider.GetUtcNow()` on every projection:
device online (newest `LastSeen` within 30 s), the over-limit elapsed time, the
voltage average and the INA226 sample (both 30 s, inclusive). Nothing is
refreshed from the database when they expire.

### Authentication on the read path (W-12)

`LoggingBehaviour` runs for every MediatR request and `PerformanceBehaviour`
for requests over 500 ms. With the flag off they still call
`IIdentityService.GetUserNameAsync` (one `AspNetUsers` query). With the flag on
they read the name claim of the authenticated principal through
`ICurrentUserName` (registered in `Program.cs` from `HttpContext.User`), or log
only the user id when there is no name claim. The name is used only in a log
line.

Authentication itself is untouched: cookie validation, Identity's periodic
security-stamp revalidation, `AuthorizationBehaviour` and endpoint
authorization run exactly as before. Their queries remain and are reported
under A's *Authentication* category (W-11), separately from state/config.

## Mutations and publication (flag on)

All ten Power mutations go through `PowerMutationCoordinator`
(`src/Application/Power/Runtime/PowerMutationCoordinator.cs`): telemetry ingest
(device and scenario), activation, disconnection, selective response, staged
restoration, manual override, outlet policy, thresholds, fault acknowledgement
and recovery clearance.

1. Wait for the store's write gate (one holder; hydration uses it too).
2. Capture the published snapshot.
3. Run the unchanged handler logic against the database (legacy reads and
   persistence are kept in D) and a detached candidate: tracked EF entities for
   durable fields, `PowerMutation.Framework` for framework state.
4. After `SaveChangesAsync` returns, the handler stages what it committed
   (config, the outlets it loaded, events, readings, INA sample, relay
   reports) and calls `MarkCommitted`.
5. When the handler returns, the coordinator builds the next snapshot from the
   captured snapshot plus the staged values (copied after the save, so
   database ids and audit fields are included), publishes it, then publishes
   the framework state. No reload.
6. If `SaveChangesAsync` throws, or the handler returns without committing
   (debounced off, pending-command refusal, refused restoration, duplicate
   acquisition), nothing is published: snapshot and framework state stay
   exactly as captured.

This fixes the pre-commit publication defect on the enabled path:
`IngestTelemetry`, `RunStagedRestoration`, `ApplySelectiveResponse` and
`SetManualOverride` no longer move the framework state before their commit.

### Lock and transaction boundaries

- **Write gate** (`PowerRuntimeStore._writeGate`, async, single holder): held
  from capture through the handler's database reads, its single implicit
  `SaveChanges` transaction, and publication. Mutations therefore commit and
  publish in one total order, and each one reads the previous one's committed
  state. While D keeps legacy ingest persistence, ingest holds the gate during
  its database round trips; E moves ingest evaluation to runtime state.
- **Transaction:** unchanged. Each mutation is one implicit `SaveChanges`
  transaction. Publication happens after it returns, outside it.
- **Readers** take no lock. The published reference is swapped atomically and
  the snapshot is immutable.
- **Framework store** (`LoadSheddingStateStore`): on the enabled path only the
  coordinator writes it, under the write gate, after commit.

### Extension points for E

| Need | API |
|---|---|
| Immutable capture | `PowerMutation.Captured` |
| Serialized candidate mutation | `PowerMutationCoordinator.ExecuteAsync` + `PowerMutation.UpdateFramework` |
| Post-commit publication | `PowerMutation.MarkCommitted` |
| Event insertion | `PowerMutation.StageEvent` (latest event: `PowerRuntimeSnapshot.LatestEvent`) |
| Live-only publication | `PowerMutation.MarkLiveOnly`: publishes outlet `CurrentWatts`/`LastSeen`, voltage samples and the INA sample only; config, events, command/recovery fields and framework changes are not published |

## Single-writer topology

The snapshot is only correct while exactly one backend process writes the
rig's state: another process's commits never reach this process's snapshot.

- With the flag on, startup takes an exclusive lock on
  `mor-power-runtime-<identity>.lock` in `Telemetry:SingleWriterLockDirectory`
  (default: temp directory). `<identity>` is a SHA-256 prefix of host, port,
  database and search path (never credentials). A second backend for the same
  database on the same host fails at startup with `SingleWriterGuardException`.
  The OS releases the lock when the process exits, including on a crash.
- **Deployments must run one active backend and be stop-before-start.** A
  rolling or blue/green deploy that overlaps two backends is not supported with
  cached reads.
- **This guard is not distributed fencing.** Two hosts, or two containers with
  separate temp directories, do not see each other's lock. Any topology where
  writers can overlap across hosts is an **enablement blocker** for cached
  reads. There is no database lease and nothing is refreshed periodically.
- Writes to the rig's tables from outside the backend (manual SQL, another
  tool) are not seen until the next restart. Do not do that with the flag on.

## Known limits

- An uncertain commit (the connection drops after `COMMIT` but before EF sees
  success) is treated as a failure, so its changes are not published although
  they may be durable. The next ingest (1 Hz) republishes every outlet and the
  config from the database; an event from that commit would be missing from the
  recent list until restart. E owns uncertain-commit recovery for batches.
- `RecentEvents` ties: the legacy query orders by timestamp only, so events
  sharing a timestamp have no defined order there. The snapshot orders them by
  id (insertion order).
- Retention (`TelemetryRetentionService`, at least 6 h raw) can delete the
  stored INA sample the snapshot still holds. Only samples younger than 30 s
  are ever displayed, so the response is the same.

## Evidence

Run from `Mor.PowerManagement/` with the local throwaway PostgreSQL (never
Neon):

```powershell
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:MOR_TEST_DB_CONNECTION = 'Host=127.0.0.1;Port=55432;Username=<test user>;Password=<test password>;Database=<test db>'
dotnet test tests/Application.UnitTests/Application.UnitTests.csproj --filter "FullyQualifiedName~PowerRuntime"
dotnet test tests/Infrastructure.IntegrationTests/Infrastructure.IntegrationTests.csproj --filter "FullyQualifiedName~RuntimeRead"
dotnet test tests/Infrastructure.IntegrationTests/Infrastructure.IntegrationTests.csproj --filter "FullyQualifiedName~ControlCharacterization"
```

Zero-query counts come from A's interceptor (`TelemetryDatabaseMetrics`) on the
real Application/Infrastructure registrations and MediatR pipeline.

| Requirement | Test | Result at this commit |
|---|---|---|
| 10,000 unchanged config requests after hydration: zero config/roster queries | `RuntimeRead_TenThousandConfigPolls_AfterHydration_ExecuteZeroQueries` | 0 commands, 0 connection opens (flag off: 2 per poll) |
| 1 and 3 concurrent administrator state pollers: zero recurring queries | `RuntimeRead_ConcurrentAdministratorStatePollers_…(1)` / `(3)` | 1,000 / 3,000 polls: 0 commands, 0 *Authentication* (`AspNetUsers`) commands (flag off: 6 per poll, 1 of them `AspNetUsers`) |
| Concurrent hydration requests execute one hydration | `RuntimeRead_ConcurrentFirstUseRequests_ExecuteOneHydration`, `PowerRuntimeTests.Hydration_*` | 40 concurrent first requests: 1 hydration, 5 queries |
| Failed commits publish nothing | `RuntimeRead_FailedCommits_PublishNoConfigEventCommandOrFramework`, `PowerRuntimeTests.FailedCommit_*` | ingest shed, selective+override, override, thresholds, disconnect: snapshot and framework unchanged, database rolled back; the legacy path still shows the pre-commit defect |
| Concurrent ingest/admin updates keep order and fields | `RuntimeRead_ConcurrentIngestAndAdminUpdates_PreserveOrderingAndFields`, `PowerRuntimeTests.ConcurrentMutations_*` | 71 commits, 71 publications; snapshot equals database and a fresh reload |
| Freshness expires without a database refresh | `RuntimeRead_FreshnessExpires_WithoutDatabaseRefresh`, `PowerRuntimeTests.Freshness_*` | online/voltage/INA expire at 30 s + 1 ms with 0 commands |
| Mains-voltage averages match the baseline | `RuntimeRead_MainsVoltageAverage_MatchesLegacySql_…`, `PowerRuntimeTests.VoltageWindow_*` | 450 probes incl. the 30 s boundary equal the legacy SQL `AVG` within 1e-9 |
| Second same-host writer cannot acquire the guard | `RuntimeRead_SecondSameHostWriter_CannotAcquireTheGuard`, `PowerRuntimeTests.SingleWriterGuard_*` | `SingleWriterGuardException` |
| B's successful control traces are equivalent with caching off/on | `RuntimeRead_ControlTraces_AreEquivalent_WithCachedReadsOffAndOn`, plus the unchanged `ControlCharacterization` suite (legacy constructors) | 29-action script byte-identical; snapshot equals the legacy queries and a reload after every cached action |
| Relay report without matching id/state is not an acknowledgement | `RuntimeRead_RelayReportWithoutMatchingCommand_IsNotAnAcknowledgement` | acknowledgement only on matching id **and** state |

Traces: `artifacts/bin/Infrastructure.IntegrationTests/debug/control-traces/RuntimeRead_Differential_Cached{Off,On}.jsonl`.

### Still pending (not proven here)

- Real Neon suspension with cached reads on (G, LoadWise rehearsal).
- Ingest still queries and writes on every acquisition (W-06); E removes that.
- Authentication queries (login, `manage/info`, security-stamp revalidation)
  remain by design and are attributed separately.
