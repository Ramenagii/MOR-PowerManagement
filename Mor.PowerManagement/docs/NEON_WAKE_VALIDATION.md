# Neon wake validation (PLAN-0001, slice S0001.7, Spec G)

| | |
|---|---|
| Branch | `SeiShai/plan0001-g-quiet-db`, based on `feat/plan-0001-neon-cap-fix` at `1f48e6a` (A, B, C, D, E merged; F not merged) |
| Code | `34db6b9` (quiet database mode and tests), `116dc9f` (session-counter positive control) |
| Date | 2026-10-20 |
| Method | Unit tests, plus integration tests against the **local throwaway Docker PostgreSQL 18 only**, with Spec A's command/connection interceptors and `pg_stat_database.sessions` as a physical-connection cross-check. Hosted services ran on a virtual clock, so 15-minute windows elapsed in seconds. No Neon project (LoadWise or production), no Render service and no production setting was contacted. |
| Status | Local evidence complete. **G-9 (external probes) and G-10 (real Neon suspension) are PENDING**, and so is the compute gate that depends on them. |

All paths are relative to `Mor.PowerManagement/`. Finding IDs (W-, U-, X-) are those of [`NEON_WAKE_AUDIT.md`](NEON_WAKE_AUDIT.md).

## 1. What changed

`Telemetry:QuietDatabaseMode` (default `false`). With the flag off nothing changes in any environment: the same health checks and endpoint mapping, and no validation.

With the flag on:

| Behaviour | Where |
|---|---|
| Startup fails unless `Telemetry:CachedReadsEnabled`, `Telemetry:RuntimeIngestEnabled` and `Telemetry:BatchPersistenceEnabled` are all `true`. The message lists the missing keys. | `src/Infrastructure/Power/QuietDatabasePolicy.cs` (`Validate`) |
| Aspire's `ApplicationDbContext` health check is disabled (`Aspire:Npgsql:EntityFrameworkCore:PostgreSQL[:ApplicationDbContext]:DisableHealthChecks=true`). Retries, metrics and tracing are kept: they issue no SQL of their own. | `QuietDatabaseRegistration.AddQuietDatabase` |
| `/alive` (liveness: the in-process `self` check only) and `/health` (readiness) are mapped in **every** environment. Readiness reads memory only. It is `Unhealthy` (503) until D's snapshot is hydrated and E's writer is initialized, and whenever the loss bound is breached or a dropped run is not yet recorded. It is `Degraded` (200) for a recorded gap or a failed flush awaiting retry. | `QuietDatabaseRegistration.MapQuietDatabaseHealthEndpoints`, `QuietRuntimeReadinessCheck` |
| After `Build()`, startup rejects any health check other than `self`/`quiet-runtime`, any `IHealthCheckPublisher`, and connection strings that set `Keepalive`>0, `TCP Keepalive=true` or `Minimum Pool Size`>0. Messages name keywords only, never values. | `EnsureQuietDatabasePolicy` |
| `src/Web/Program.cs` calls `AddQuietDatabase()` before the service registrations, and `EnsureQuietDatabasePolicy()` first in the startup scope. It then maps the quiet endpoints instead of `MapDefaultEndpoints()` when the flag is on. | `src/Web/Program.cs` |

No DependencyInjection file, DbContext, migration, retention, history-query, buffer/writer or seeder code was edited. No endpoint changed, so `v1.json` was not committed.

### Enabling it (rehearsal only)

Set all four keys together, for example as environment variables:

```
Telemetry__CachedReadsEnabled=true
Telemetry__RuntimeIngestEnabled=true
Telemetry__BatchPersistenceEnabled=true
Telemetry__QuietDatabaseMode=true
```

Point the platform health check at **`/alive`**. `/health` is readiness: a restart discards buffered history, so it must not be used as a restart trigger. Run one active backend, stop-before-start (D's single-writer rule).

## 2. Local evidence (Docker PostgreSQL 18, not Neon)

Command: `dotnet test tests/Infrastructure.IntegrationTests/Infrastructure.IntegrationTests.csproj --filter "FullyQualifiedName~QuietDatabase"`, 16/16 passing. Non-Development hosts use the `Staging` environment, because `Production` forces `SslMode=Require`, which the local container does not offer. The Production flag-off mapping is checked against a synthetic unroutable host, and the Production connection-string path is covered by the unit tests (G-3).

| Scenario | Measured |
|---|---|
| Counter positive control | 1 unpooled connection → 1 physical session counted |
| 1,000 `GET /alive`, quiet on | 0 commands, 0 connection opens, 0 physical sessions |
| 100 `GET /health`, quiet on | `Healthy`; 0 commands, 0 connection opens, 0 physical sessions |
| Hydration failure, quiet on | `/health` 503 `Unhealthy`, `/alive` 200 |
| Buffer overflow (1 acquisition dropped, gap not yet recorded) | `/health` 503 `Unhealthy` |
| Flag off, `Staging` and `Production` | `/alive` and `/health` unmapped (404 in the test host; the real app serves the SPA `index.html`); 0 commands |
| **Baseline**: flag off, Development, 10 `GET /health` | checks `self`, `ApplicationDbContext`; 10 EF commands, 10 EF connection opens, 0 new physical sessions (the pool reused its connection). The audit's "new unpooled physical connection per call" (W-13) was not reproduced. Each call is still a database round trip, which on Neon is activity. |
| Hosted services, quiet on | `TelemetryHostedService` (OpenTelemetry), `HealthCheckPublisherHostedService` (no publishers), `DataProtectionHostedService` (local key ring), `TelemetryRetentionService` (its `ExecuteTask` had already completed at start), `BatchWindowCoordinator`, `GenericWebHostService`. Only one timer runs on the host clock: the coordinator's 1 s memory-only tick. |
| Startup (fixture pre-migrated; seeding skipped, see W-02) | 9 commands = 6 *Startup* (hydration, writer initialization) + 3 *Retention/bulk* (initialization maintenance) + 0 unattributed; 1 hydration |
| Empty off-hours interval, 1,800 virtual s (2 × flush interval) | 0 commands, 0 connection opens, 0 physical sessions |
| Device only, 900 virtual s (900 ingests at 1 Hz, 1,800 config polls at 2 Hz) | config 0, ingest 0; one scheduled flush of 870 acquisitions = 10 *Retention/bulk* commands (write + maintenance) |
| Device stops | one inactivity flush (10 commands), then 0 commands and 0 physical sessions for 1,800 virtual s |
| 1 administrator, 35 virtual min (1,050 state polls, 2,100 ingests, 4,200 config polls) | state 0, config 0, ingest 0, unattributed 0. *Authentication*: login 3 commands, security-stamp revalidation at 30 min 1 command. |
| 3 administrators, same 35 min (3,150 state polls) | state 0, config 0, ingest 0, unattributed 0. *Authentication*: login 9 (3 per session), revalidation 3 (1 per session). |
| History requests | `15m` prefix miss 1 command, `1h` miss 1 command, repeated `15m` hit 0; all attributed to *History*, none to authentication or state |
| Control transition (overload confirmed after 3 s) | Priority-based load shed: 4 immediate ingest commands, 2 events and the outlet status committed **before** the ingest returned; durable outlet state equals the published snapshot |
| 10 administrator threshold commands | each read back from a fresh connection right after `Send` returned; 2 commands each |
| Batch + maintenance contention | 860 acquisitions / 4,300 rows plus maintenance over 120,000 expired rows: **306 ms wall** (expired rows remaining 0). Control latency (durable `UpdateThresholds`): idle p50 5.9 ms / max 57.0 ms; during the batch window n=81, p50 3.6 ms / max 6.8 ms. |

The timeline test drives login and revalidation through Identity's own `UserManager`/`SignInManager` calls (`FindByNameAsync`, `CheckPasswordSignInAsync`, `CreateUserPrincipalAsync`, `ValidateSecurityStampAsync`) inside *Authentication* scopes. It does not go through the HTTP `/login` or `manage/info` endpoints, which live in Web; their extra queries are on-demand and also attributed to *Authentication* by A's path mapping. Authentication is not bypassed anywhere.

Contention latencies are local and say nothing about Neon round-trip time. The ≤2 min batch/maintenance gate must be re-measured on LoadWise (G-10).

## 3. Disposition of every audit finding

Each finding is fixed (G), already resolved by D/E, assigned to F, externally pending (X), or a confirmed non-issue.

| ID | Finding | Disposition | Evidence |
|---|---|---|---|
| W-01 | Startup migrations | **Confirmed non-issue** (bounded to startup), unchanged | `Program.cs` runs `InitialiseDatabaseAsync` once, inside the *Startup* scope and before `Run`. It is skipped for build-time doc generation. Correctness is not weakened. |
| W-02 | Startup seeding | **Confirmed non-issue** (bounded); optional N+1 / no-op-write reduction **assigned to F** (owns the seeder) | Same call path as W-01. The test host skips seeding, because the fixture is pre-seeded and B's baseline forbids reseeding. |
| W-03 | Build-time OpenAPI generation | **Confirmed non-issue** (verified) | `dotnet build src/Web/Web.csproj` with `ConnectionStrings__Mor.PowerManagementDb` set to the unroutable documentation address 192.0.2.1 (`Timeout=3`) succeeded in about 5 s, so no connection was attempted. The regenerated `v1.json` differed only in line endings and was reverted. |
| W-04 | `TelemetryRetentionService` | **Already resolved by E** for the timer (it returns at once under batch persistence; maintenance runs only inside batch windows). **Assigned to F** for the retention algorithm, *pending F merge*. | Its `ExecuteTask` completed at start; the empty 2 × flush interval gave 0 commands. |
| W-05 | Device config poll | **Already resolved by D** | 1,800 and 4,200 polls → 0 commands |
| W-06 | Device telemetry ingest | **Already resolved by E** (D hydration/publication) | 900 steady ingests → 0 commands; transitions stay immediate and durable |
| W-07 | Dashboard current state | **Already resolved by D** (with U-1) | 1,050 and 3,150 authenticated polls → 0 commands |
| W-08 | History series | **Already resolved by E** (tail merge; misses only at durable-boundary changes). Tier selection **assigned to F**. | Miss 1 command, hit 0, attributed to *History* |
| W-09 | Framework rules list | **Confirmed non-issue** (on demand, no SPA caller) | Audit §4.2 |
| W-10 | Administrator/control commands | **Already resolved by D** (serialized, post-commit publish); durability kept | Durable before return, read back from a fresh connection |
| W-11 | Authentication | **Fixed (attributed, G-6)**: in the activity budget, no bypass | Login 3 commands per session; 1 revalidation command per session per 30 min |
| W-12 | MediatR identity lookup | **Already resolved by D** (U-1): with cached reads on, `LoggingBehaviour`/`PerformanceBehaviour` take the user name from claims (`ICurrentUserName`) | 0 state commands for authenticated polls |
| W-13 | Health checks | **Fixed (G-1, G-2)** under quiet mode | 0 DB activity for 1,000 `/alive` and 100 `/health`; baseline recorded above |
| W-14 | Aspire Npgsql enrichment | **Fixed (G-2)**: only the DB health check is disabled under quiet mode; retries (X-2), metrics and tracing are kept | Unit test: `ApplicationDbContext` check present with the flag off, absent with it on |
| W-15 | Keepalive / pool | **Verified (G-3)**; whether the idle pool delays suspension is **externally pending (G-10)** | Effective connection string for the URL and key/value forms × Production/Development: `Keepalive=0`, `TCP Keepalive=false`, `Minimum Pool Size=0`, `Pooling=true`. Quiet startup rejects any of them being set. See §4 for why the idle pool matters. |
| W-16 | Health-check publisher | **Confirmed non-issue**; quiet mode now enforces 0 publishers | Hosted-service list above |
| W-17 | Developer exception page DB filter | **Confirmed non-issue** (Development error path only) | Audit §4.2 |
| W-18 | AppHost run mode | **Confirmed non-issue** (code review): no health check on the database resource, no `WaitFor(database)`; `WaitFor(web)` applies only to the frontend app. G added no `WithHttpHealthCheck`. | `src/AppHost/Program.cs`. No AppHost-model test was added: the only projects that reference the AppHost (`Web.AcceptanceTests`, and `TestAppHost` via `Application.FunctionalTests`) fail on the pre-existing NU1902/NU1903 MessagePack advisories, and test csproj files are out of scope. |
| W-19 | Restarts, deploys, host sleep/wake | **Externally pending (X)**, documented | Each start repeats W-01/W-02 plus hydration and initialization maintenance (9 commands in the test host, excluding migrations/seed): one wake per start. Backend-host sleep (Render Free spins down after 15 min without requests) is not DB suspension. It stops the process (graceful stop drains the buffer), and the next request pays the full startup. |
| W-20 | External monitoring / platform probes | **Externally pending (X), G-9 PENDING** | The Render plan, health-check path/interval and any pingers are not supplied. Recommendation: target `/alive` with quiet mode on. An `/api/*` probe would wake the DB. |
| W-21 | Unmounted frontend pollers | **Confirmed non-issue today** (latent; frontend, unassigned) | Audit §4.2 |
| W-22 | Policies view polls hidden tabs | **No action needed**: it feeds W-07, which is now 0 queries (D + U-1). The frontend change stays unassigned. | 0 state commands |
| W-23 | Template endpoints | **Confirmed non-issue** (no SPA caller) | Audit §4.2 |
| U-1 | W-12 ownership | **Resolved by D** | As W-12 |
| U-2 | W-21/W-22 frontend | **No action needed** once U-1 was fixed; remains frontend-owned | As W-22 |
| U-3 | `MUST_READ.md` §4 cadence (5 s / 15 s) | **Externally pending / deferred**: `MUST_READ.md` must not be edited before 31 Oct 2026 (its own header) and is outside G's files. The same stale cadence in `ARCHITECTURE.md` was corrected. | `docs/ARCHITECTURE.md` §1, §6 |

Cross-cutting notes:

- **X-1:** pool defaults confirmed (W-15).
- **X-2:** retries kept; they occur on failures only.
- **X-3:** no idle-in-transaction path; nothing changed.
- **X-4:** resolved with U-1.
- **X-5:** revalidation measured: 1 command per session per 30 min.
- **X-6:** state no longer uses `IMemoryCache` misses, under D.

## 4. Compute projection (method; gate PENDING)

Neon bills the union of active intervals. A compute stays active until about 5 minutes after the last activity, so with a fixed 0.25 CU:

> CU-h/month = 0.25 × |⋃ᵢ [tᵢ, tᵢ + dᵢ + 5 min]|

Here tᵢ is each database activity instant and dᵢ its duration; overlapping intervals are counted once. Operating plan: 465 h/month with the device on, giving 465 × 4 = **1,860 batch windows** (one flush every 15 min). The device-off hours contribute one inactivity flush when the device stops, then 0 (measured).

| Case | Active time per batch | Device-only month | vs ≤75 CU-h |
|---|---|---|---|
| A1: idle pooled connections do not count as activity (Neon's documented behaviour, see below); local d = 0.31 s | 5 min + 0.31 s | 1,860 × 5.005 min = 155.2 h → **38.8 CU-h** | meets |
| A1 at the ≤2 min batch/maintenance gate | 7 min | 217 h → **54.3 CU-h** | meets |
| A2: Neon counted an idle pooled connection until Npgsql prunes it (`Connection Idle Lifetime` 300 s + ≤10 s prune) | ≈10.0–10.2 min | ≈310–315 h → **77.5–78.8 CU-h** | **fails** |

Additions on top of the device-only figure:

- **Administrator sessions:** each session revalidates once per 30 min (measured). A revalidation that lands outside a batch tail adds at most 5 min, so the upper bound is 10 min of active time, or 0.042 CU-h, per session-hour.
  - Headroom in A1 at the measured d: 75 − 38.8 = 36.2 CU-h, or at least 869 administrator session-hours/month.
  - At the 2 min gate: 20.7 CU-h, or at least 497 session-hours.
- **History misses:** these happen when the durable boundary moves, which is right after a batch commit, so they fall inside that batch's tail. Window changes are on demand.
- **Logins, control commands, control transitions and restarts:** each adds at most 5 min (plus its own duration) when outside a tail. They are on demand and counted as they occur.

**Idle-pool evidence:** Neon's compute-lifecycle documentation says scale to zero treats only idle-in-transaction connections as active (https://neon.com/docs/introduction/compute-lifecycle). Neon's blog on long-running applications says scale to zero works while clients are connected, provided there is no activity, no WAL sender and no autovacuum (https://neon.com/blog/using-neons-auto-suspend-with-long-running-applications). The code never leaves a connection idle in a transaction (X-3). That points to A1. It is documentation, not a measurement, and **G-10 must confirm it**. If the rehearsal shows A2, the fix is a lower `Connection Idle Lifetime` in the hosted connection string. That is a configuration change for the user to approve, made only with that evidence, and nothing was changed speculatively.

**Gate status: PENDING.** The local projection meets the gate in A1 and fails in A2. Neither Neon's idle-pool behaviour nor the real batch/maintenance duration on Neon has been measured. Transfer and storage gates come from E's and F's measurements and are not re-derived here (retention *pending F merge*).

## 5. Pending gates

| Gate | Status | What closes it |
|---|---|---|
| G-9: external probes (W-20) | **PENDING (X)** | The user supplies the Render plan, health-check path/interval and any pingers. Recommended path: `/alive`. Workers do not touch production. |
| G-10: real suspension on LoadWise | **PENDING** | With all four flags on, against the LoadWise rehearsal project (never production): capture Neon console/monitoring suspension and resume timestamps across at least one full 15-minute batch cycle, with **no SQL probes during the quiet interval**. Record (a) suspension within about 5 min of the last batch while the backend process stays up and holds its idle pool (decides A1/A2), (b) the batch + maintenance duration (≤2 min gate), and (c) backend-host state separately from DB state. |
| Compute ≤75 CU-h/month | **PENDING** | §4 recomputed with G-10's measured intervals |
| Retention statements | **pending F merge** | F's retention/catch-up/compaction lands on the integration branch |
| Production 0.25 CU min/max | user action | Approved, but performed by the user in the console; not performed or verified by G |
