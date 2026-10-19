# Neon wake-source audit (PLAN-0001, slice S0001.7, Spec C)

| | |
|---|---|
| Baseline | `feat/plan-0001-neon-cap-fix` at `54c4885` (this branch: `SeiShai/plan0001-c-wake-audit`) |
| Date | 2026-10-19 |
| Method | Read-only static inspection of the checkout and of the restored NuGet packages. No application run, no SQL, no cloud console, no production access. User-secrets were not inspected. |
| Status | Static inventory complete. Every runtime-dependent finding is marked **R** and stays open until A's measurement or G's rehearsal evidence lands. Every finding that depends on hosting or Neon settings is marked **X** (external/pending). |

All paths are relative to `Mor.PowerManagement/`. Line numbers refer to `54c4885`.

## 0. Evidence legend

| Mark | Meaning |
|---|---|
| **S** | Static: established from this repository's source/config at the cited lines. |
| **S-pkg** | Static: established from restored package metadata (XML docs, configuration schema, member names present in the assembly). Not decompiled; behaviour inferred from the documented API. |
| **R** | Runtime-dependent: the code path is certain, but the database effect (round trips, physical connection, whether Neon counts it as activity) must be measured. |
| **X** | External/pending: depends on hosting, Neon console, or monitoring settings that the repository cannot establish. Not to be filled from production. |
| **C** | Coordinator-supplied fact (coordinator, 2026-10-19), taken from the user's console screenshots. Not independently verified by this audit. |

## 1. Topology: what the repository establishes and what it does not

| Fact | Value | Evidence |
|---|---|---|
| Production host | Render web service, Docker, `ASPNETCORE_ENVIRONMENT=Production`, one instance during migration startup | S: `Dockerfile:1,32`, `docs/DEPLOYMENT.md:1-11,39-42` |
| Render plan (free and sleeping vs always-on), health-check path, health-check interval, zero-downtime/overlapping deploy behaviour | Unknown | **X** — no `render.yaml`, `fly.toml`, CI workflow or uptime-monitor configuration is tracked. The comments that mention "free tier sleeps" (`TelemetryRetentionService.cs:15-17`, `docs/ARCHITECTURE.md:141-145`) are not evidence of the deployed plan. |
| External uptime pingers | None in the repository | **X** |
| Deployed backend SHA | Unknown | **X** |
| Production database | Neon project `mor-power-management`, branch `br-floral-water-b3rucn2c`, Free plan, AWS ap-southeast-1, PostgreSQL 18; autoscaling 0.25–2 CU; scale-to-zero after 5 min (Free default, not changeable); usage since 2026-10-01: transfer 5.05/5 GB (limit reached), storage 64.44 MB, compute 24.71 CU-h; monitoring showed many suspended periods | **C** |
| Rehearsal database | Neon `LoadWise` (`wispy-feather-77577610`): fixed 0.25 CU, 5-min suspend default; Neon rejects suspend changes on Free | **C** |
| Development database target | `appsettings.Development.json` names a local `127.0.0.1:5432` database, but user-secrets (`Web.csproj` `UserSecretsId`) may override it | S / **X** (secrets not inspected) |
| Aspire AppHost | Run mode only: `AddConnectionString` (external database), Web project, Vite frontend. `AddAzureContainerAppEnvironment("aca-env")` only matters for an `azd`/ACA publish, which is not the documented live host | S: `src/AppHost/Program.cs:5-30` |
| Firmware cadence (the live device load) | Telemetry `TELEMETRY_INTERVAL_MS 1000`, config poll `CONFIG_INTERVAL_MS 500`; both fire on fixed intervals while Wi-Fi is up, with no success gating or backoff | S: `firmware/mor-power-device/config.h:88,107`, `mor-power-device.ino:728-736` |

Neon behaviour relied on below (Neon docs, [compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle), [scale to zero](https://neon.com/docs/introduction/scale-to-zero)):

- The 5-minute scale-to-zero timer is defined by **no active queries**.
- An **idle-in-transaction** connection counts as active.
- **Connecting** to an idle compute activates it, even when no query follows. Every new physical connection is a wake.
- The docs do not say whether an open but idle pooled connection, with no queries, holds the compute awake. **R**: G must observe this on LoadWise.

## 2. Executive summary

1. **Nothing in the backend is quiet today while any client is attached.** The ESP32 alone generates about 8 database round trips per second: 2 Hz config polls at 2 queries each, plus 1 Hz ingest at 2–3 queries and one write transaction each (W-05, W-06). One visible dashboard tab adds a 6-round-trip state refresh roughly every 6 s and a history aggregate roughly every 30 s (W-07, W-08). These are D's and E's targets.
2. **The only recurring wake source with no device and no administrators is `TelemetryRetentionService` (W-04).** It runs at least 3 SQL statements every 15 minutes for as long as the process is up, even when there is nothing to prune. Against a 5-minute suspend timer, it holds Neon active for at least one third of every idle hour. At fixed 0.25 CU that is about **21 CU-h/month across the 255 off-hours** of the 465-hour operating plan, or about **60 CU-h/month** for a host that is up 720 h with no other traffic (**R**: the active-window length per tick must be measured). Owner: F (E adapts it to the batch-window coordinator first).
3. **A hidden recurring query rides on every authenticated MediatR request (W-12).** `LoggingBehaviour` looks up the user name in `AspNetUsers` before every handler. `PerformanceBehaviour` does it again for requests over 500 ms. If D serves current state from memory but still dispatches through MediatR with the 5-second endpoint cache removed (as Spec D requires), this becomes **one `AspNetUsers` query per 2-second poll per administrator**. That is more than today's traffic, and it would break D's "zero recurring state queries" gate. The file is not in any wave's ownership list, so **the coordinator must assign it** (§6).
4. **Health checks are a non-issue in Production as deployed, and a real wake source in Development.** Production maps no `/health` or `/alive` (`ServiceDefaults/Extensions.cs:105`). A Render probe of `/health` would receive the SPA `index.html` fallback with no database work. The Aspire database health check is registered in every environment, but only Development exposes it. There, every `/health` call opens a **new unpooled physical connection** (W-13, S-pkg + **R**). `docs/DEPLOYMENT.md:82` wrongly says `/health` returns `Healthy` in production.
5. **No connection keepalive, health-check publisher, OpenTelemetry exporter, HTTP resilience handler, data-protection store or AppHost resource generates SQL.** These are confirmed non-issues (§5). G must not "fix" the self-only liveness check.
6. **Startup does about 30–40 sequential round trips and several write transactions on every process start**, including startups where nothing has changed (W-01, W-02). This is bounded to startup and correct, so it is not a G fix. Restarts, deploys and any host sleep/wake each repeat it (W-19, **X**).

## 3. Cross-cutting database behaviour (applies to every source below)

| ID | Topic | Finding | Evidence |
|---|---|---|---|
| X-1 | Connection lifetime | `AddDbContext` (not pooled contexts): one scoped `ApplicationDbContext` per request or scope. EF opens the connection per query or `SaveChanges` and returns it to the Npgsql pool. Npgsql pool defaults apply because code sets none: `Pooling=true`, `MinPoolSize=0`, `ConnectionIdleLifetime=300 s`, pruning every 10 s, `KeepAlive=0`, `TcpKeepAlive=false`. Idle physical connections therefore close after about 5 minutes **without sending SQL**. For a `postgresql://` URI, `NormalizePostgresConnectionString` keeps only host/port/db/user/password/`sslmode`/`channel_binding` and drops every other query parameter. A key/value connection string passes through unchanged, so any keepalive/pool keyword in the hosted secret would survive (**X**). | S: `src/Infrastructure/DependencyInjection.cs:28-33,89-144`; S: no `KeepAlive`/`Keepalive` anywhere in `src/` |
| X-2 | Retry policy | `EnrichNpgsqlDbContext` enables EF's `NpgsqlRetryingExecutionStrategy` because `DisableRetry` defaults to `false`. With EF defaults, a transient failure is retried up to 6 times with exponential delay capped at 30 s. Retries add round trips and can extend an active window on a flaky or waking compute. They occur only on failures and are not recurring. Settings live under the configuration section `Aspire:Npgsql:EntityFrameworkCore:PostgreSQL` (`DisableRetry`, `DisableHealthChecks`, `DisableMetrics`, `CommandTimeout`). | S: `DependencyInjection.cs:35`; S-pkg: `Aspire.Npgsql.EntityFrameworkCore.PostgreSQL` 13.2.0 `ConfigurationSchema.json`, XML doc ("Configures retries, health check, logging and telemetry"), members `EnableRetryOnFailure`, `NpgsqlRetryingExecutionStrategy`; **R**: exact retry count/delay |
| X-3 | Transaction lifetime | No explicit `BeginTransaction`/`TransactionScope` anywhere in `src/`. Each `SaveChanges` runs its own short implicit transaction. Reads before it run outside any transaction. `ExecuteSql*` statements are single-statement atomic. **No code path leaves a connection idle-in-transaction**, which Neon would count as active. | S: grep of `src/` |
| X-4 | MediatR identity lookups | Every MediatR request from an authenticated user runs `IIdentityService.GetUserNameAsync` → `UserManager.FindByIdAsync`: one `AspNetUsers` query per dispatch. Requests slower than 500 ms do a second lookup. Anonymous device requests skip both. See W-12. | S: `src/Application/Common/Behaviours/LoggingBehaviour.cs:21-34`, `PerformanceBehaviour.cs:27-52`, `src/Application/DependencyInjection.cs:22-29` |
| X-5 | Cookie authentication | Identity cookie defaults are not overridden: `SecurityStampValidator` revalidates each signed-in session on its first request after a 30-minute interval (user lookup plus principal regeneration: user claims, roles, role claims). Data protection is not configured (`AddDataProtection`/`PersistKeysTo*` absent), so keys live in the container's local key ring. A redeploy to a fresh filesystem invalidates existing cookies and forces a re-login. | S: `DependencyInjection.cs:57-79`; S: grep; **R**: query count per revalidation; **X**: Render filesystem persistence |
| X-6 | In-process caches | `IMemoryCache` (`Program.cs:45`) backs the 5 s state cache and the per-window history caches. `GetOrCreateAsync` is **not single-flight**, so concurrent misses each run the query. Caches are empty after every restart. | S: `src/Web/Endpoints/Dashboard.cs:56-70,81-126` |

## 4. Inventory of database wake sources

Columns: **NoDev** means it still happens with no ESP32 posting. **NoAdmin** means it still happens with no signed-in browser. **NoBuf** means it still happens with no buffered/new telemetry to persist. "Extends window" means it can keep an already-active compute from reaching the 5-minute idle threshold.

### 4.1 Summary table

| ID | Source | Trigger / cadence | DB work per occurrence | NoDev | NoAdmin | NoBuf | Owner |
|---|---|---|---|---|---|---|---|
| W-01 | Startup migrations | Every process start | Migration history/lock/applied-list queries, plus pending migrations | yes | yes | yes | G (verify bounded) |
| W-02 | Startup seeding | Every process start, right after W-01 | About 30–40 sequential round trips, at least 3 write transactions, plus Identity writes | yes | yes | yes | G verify; seeder file is F's in Wave 4 |
| W-03 | Build-time OpenAPI generation | `dotnet build` of `Web` | None expected (init skipped) | — | — | — | G (verify) |
| W-04 | `TelemetryRetentionService` | Every 15 min from process start, indefinitely | At least 3 statements, even when empty; up to 22 statements over at most 50k rows each | **yes** | **yes** | **yes** | **F** (E adapts first) |
| W-05 | Device config poll | ESP32 every 500 ms | 2 SELECTs, about 6 rows | no | yes | yes | **D** |
| W-06 | Device telemetry ingest | ESP32 every 1 s | 2–3 SELECTs plus 1 write transaction (about 6 INSERT + about 6 UPDATE) | no | yes | n/a | **E** (D for hydration/publication) |
| W-07 | Dashboard current state | Each visible SPA tab: every 2 s after the previous reply; Policies view also every 15 s, **including hidden tabs** | Cache miss (at most 1 per 5 s per process): 5 SELECTs plus 1 identity SELECT | yes | no | yes | **D** (+ W-12) |
| W-08 | History series | Dashboard hero: `15m` every 30 s. Telemetry view: active window every 30 s/60 s/60 s/300 s/never. Plus a reload on tab-visible | Cache miss: 2 SELECTs (one aggregates raw + rollups) plus 1 identity SELECT | yes | no | yes | **E** (tail merge) / **F** (tier selection) |
| W-09 | Framework rules list | On demand only; no current SPA caller | 1 SELECT plus identity SELECT | yes | no | yes | D if it is ever polled; no action |
| W-10 | Administrator/control commands | Operator action | 1–3 SELECTs plus 1 write transaction plus identity SELECT | yes | no | yes | **D** (serialize, post-commit publish) |
| W-11 | Authentication (login, `manage/info`, security stamp) | Login, tab restore, per session every 30 min | Several `AspNetUsers`/claims/roles queries; login may write | yes | no | yes | G attributes only (no bypass) |
| W-12 | MediatR identity lookup | Every authenticated MediatR dispatch (W-07…W-10 misses and commands) | 1 `AspNetUsers` SELECT (2 if the request takes over 500 ms) | yes | no | yes | **Unassigned: coordinator** |
| W-13 | Health checks (`/health`, `/alive`) | Each probe call | Development `/health`: a new unpooled physical connection. `/alive`: none. Production: not mapped (SPA fallback, none) | yes | yes | yes | G |
| W-14 | Aspire Npgsql enrichment | Registration-time | Adds retries (X-2), the DB health check (W-13) and metrics/tracing (no SQL) | — | — | — | G (verify) |
| W-15 | Connection keepalive / pool | Idle pool | None by default (KeepAlive off; prune closes idle connections without SQL) | — | — | — | G (verify; **R**/**X**) |
| W-16 | Health-check publisher | Hosted service | None (no `IHealthCheckPublisher` registered) | — | — | — | non-issue |
| W-17 | Developer exception page DB filter | Development only, on a database exception | Migration-state queries on the error path | — | — | — | non-issue (document) |
| W-18 | Aspire AppHost run mode | Local `dotnet run` of AppHost | None (no health check, no `WaitFor(database)`) | — | — | — | non-issue |
| W-19 | Process restarts, deploys, host sleep/wake | **X** | Repeats W-01 and W-02; caches cold; possible re-login (X-5) | yes | yes | yes | G (document); D (single-writer) |
| W-20 | External monitoring / platform probes | **X** | Depends on path: `/health` and `/alive` are DB-free in Production; any `/api/*` path would hit the DB | ? | ? | ? | **X** — user action |
| W-21 | Unmounted frontend pollers | None today | None today (latent) | — | — | — | Unassigned (frontend) |
| W-22 | Policies view polling hidden tabs | Every 15 s while the view is open, even hidden | Feeds W-07 | yes | no | yes | Unassigned (frontend); harmless after D if W-12 is fixed |
| W-23 | Template endpoints (`TodoItems`, `TodoLists`, `WeatherForecasts`) | On request only; no SPA caller | Todo: SELECT/INSERT/UPDATE. Weather: none | — | — | — | non-issue |

### 4.2 Detail per source

#### W-01 Startup migrations

- **Where:** `src/Web/Program.cs:61-64` → `InitialiserExtensions.InitialiseDatabaseAsync` (`src/Infrastructure/Data/ApplicationDbContextInitialiser.cs:19-27`) → `InitialiseAsync` → `Database.MigrateAsync()` (`:55-68`).
- **Trigger/cadence:** once per process start, after `builder.Build()` and before `app.Run()`, so it runs before hosted services start (W-04's first tick is 15 min later). It is skipped when `isDocGen` is true (`Program.cs:6-7`).
- **DB work:** EF Core 10 `MigrateAsync`: history-table existence check, migration lock, applied-migrations read, then any pending migrations inside the strategy/transaction. Expected result volume is about 12 history rows. **R**: exact round-trip count.
- **No device / no admins / no buffer:** yes, all three. It runs on every start regardless.
- **Cache:** none. **Retry:** X-2 strategy. **Connection:** one scoped context and one pooled connection. **Transaction:** EF migration transaction(s) only while applying.
- **Extends window:** yes. It wakes Neon at boot and contributes the boot active window (≥5 min tail).
- **Disposition for G:** bounded and required. Do not skip it. Verify it runs exactly once per start (G-4).

#### W-02 Startup seeding

- **Where:** `ApplicationDbContextInitialiser.TrySeedAsync` (`:83-443`) and `EnsureAdministratorAsync` (`:445-486`).
- **DB work on every start, even when nothing changed (S):**
  - Roles: `Roles.All(...)` (`:87`); administrator `FindByNameAsync` (`:449`); `IsInRoleAsync` (`:479`).
  - Production: `SetLockoutEnabledAsync` (`:97`). The Identity `UserStore.UpdateAsync` writes a new `ConcurrencyStamp`, so this is **an `AspNetUsers` UPDATE on every start**. `FindByNameAsync("demo@localhost")` (`:102`). `CheckPasswordAsync` with the retired password (`:469`), which may rehash/update. **R**.
  - Non-production: for up to 2 users, `FindByNameAsync` plus 3 lockout/reset updates (`:119-128`).
  - `TodoLists.Any()` (`:133`); `PowerSystemConfigs.FirstOrDefaultAsync()` (`:182`).
  - Testing rig: all outlets (`:299`); stale-row `SaveChanges` when needed (`:302-305`); **5× per-outlet `FirstOrDefaultAsync` (N+1)** (`:310`); `SaveChanges` (`:355`); `setval(...)` raw SQL (`:359-360`, a write); **12× per-rule `ControlPolicies.FirstOrDefaultAsync` (N+1)** (`:387`); legacy `POL-` rows (`:416-418`); `PowerEvents.Any()` (`:424`); final `SaveChanges` (`:442`).
  - Total: about 30–40 sequential round trips and at least 3 write transactions per start. **R**: exact count, which depends on Identity internals.
- **No device / no admins / no buffer:** yes.
- **Cache:** none. **Retry:** X-2. **Connection:** same scope as W-01. **Transaction:** one implicit transaction per `SaveChanges` and per Identity write.
- **Extends window:** yes (boot window).
- **Disposition:** bounded to startup and therefore not a quiet-path defect. Collapsing the N+1 reads and skipping no-op writes would only shorten the boot window. `ApplicationDbContextInitialiser.cs` belongs to F in Wave 4 (history-identity safeguards), so any such optimization is an optional F item, not G's.

#### W-03 Build-time OpenAPI document generation

- **Where:** `Program.cs:6-7,61`; `Web.csproj` `OpenApiDocumentsDirectory`; `Microsoft.Extensions.ApiDescription.Server`. The Dockerfile disables generation (`Dockerfile:15-17`).
- **Finding:** `isDocGen` skips `InitialiseDatabaseAsync`. Building the host registers the DbContext and hosted service, but neither opens a connection at registration. The retention timer's first tick (15 min) can never be reached by a build. Expected DB work: none.
- **Evidence:** S; **R**: G must prove zero connection attempts during a `Development` build (G-4). This matters because the Development target may be a Neon branch through user-secrets.

#### W-04 `TelemetryRetentionService` (the idle wake source)

- **Where:** registered unconditionally at `src/Infrastructure/DependencyInjection.cs:84-86`. Implementation in `src/Infrastructure/Data/TelemetryRetentionService.cs`: `Interval = 15 min` (`:24`), `BatchSize = 50_000` (`:26`), `MaxBatchesPerTick = 20` (`:29`), loop (`:35-59`), prune (`:61-190`).
- **Trigger/cadence:** `PeriodicTimer(15 min)` from process start, first tick at +15 min, then every 15 min for the life of the process. It does not depend on the device, on administrators, or on whether any rows qualify.
- **DB work per tick (S):**
  1. Move-and-roll-up CTE (`:81-134`): `DELETE ... RETURNING` up to 50k raw rows older than `RawRetentionHours` (default 6), `INSERT ... ON CONFLICT` into `TelemetryReadingRollups`. It repeats until 0 rows are affected or 20 batches have run. **When nothing qualifies, it still executes once** (returns 0).
  2. INA226 prune (`:148-157`): `DELETE` up to 50k `InaReadings` older than the raw cutoff. Always executed.
  3. Rollup prune (`:159-164`): `DELETE` rollups older than `RollupRetentionDays` (default 30). Always executed, unbatched.
  - Minimum 3 statements per tick; maximum 22. Result volume to the client is only affected-row counts.
- **No device / no admins / no buffer:** **yes / yes / yes.**
- **Cache:** none. **Retry:** X-2 per statement. **Connection:** one scope per tick; the connection returns to the pool between statements. **Transaction:** each statement is atomic and independent; none spans the tick.
- **Extends window:** yes. While a device or admin keeps Neon awake, it adds load inside the window. While the system is otherwise idle, **each tick starts a fresh wake** and holds the compute for at least the 5-minute suspend timer. That is ≥33% duty while the host is up. Arithmetic at fixed 0.25 CU: 255 off-hours × ⅓ × 0.25 ≈ **21 CU-h/month**; 720 h fully idle ≈ **60 CU-h/month**. **R**: real active window per tick on LoadWise.
- **Owner:** **F** (retention execution, catch-up, compaction). E first moves it under `IHistoryMaintenance`/`BatchWindowCoordinator` on the new path (Spec E §13). G must only verify that no independent timer remains when quiet mode is on (G-5).

#### W-05 Device configuration poll — `GET /api/Device/config`

- **Where:** `src/Web/Endpoints/Device.cs:18,32-37` → `GetDeviceConfigQueryHandler` (`src/Application/Power/Queries/GetDeviceConfig/GetDeviceConfig.cs:46-70`). Authentication is `DeviceApiKeyEndpointFilter` (`src/Web/Infrastructure/DeviceApiKeyEndpointFilter.cs:22-39`), a configuration comparison with no DB.
- **Trigger/cadence:** firmware `CONFIG_INTERVAL_MS 500` (`config.h:107`) → 2 requests/s, with no backoff (`.ino:728-731`). That is about 3.35 M polls/month at 465 h (parent plan).
- **DB work:** `PowerSystemConfigs.FirstOrDefaultAsync` (1 row, `:48-50`) plus the outlet policy projection (5 rows, `:52-56`). That is 2 round trips per poll, about 4 SELECTs/s. Anonymous, so no W-12 lookup.
- **No device / no admins / no buffer:** no / yes / yes.
- **Cache:** **none**. Every poll is a cold read. **Retry:** X-2. **Connection/transaction:** pooled, no transaction.
- **Extends window:** yes, continuously while the device is online.
- **Owner:** **D** (serve from the hydrated runtime snapshot).

#### W-06 Device telemetry ingest — `POST /api/Device/telemetry`

- **Where:** `Device.cs:17,23-28` → `IngestTelemetryCommandHandler.Handle` (`src/Application/Power/Commands/IngestTelemetry/IngestTelemetry.cs:158-413`). The same handler serves `POST /api/Dashboard/scenarios/ingest` (`Dashboard.cs:51,303-314`), which runs only on operator action because the scenario UI is not mounted (W-21). That path is authenticated, so it also pays W-12.
- **Trigger/cadence:** firmware `TELEMETRY_INTERVAL_MS 1000` (`config.h:88`) → 1 request/s, no backoff (`.ino:733-736`). That is about 1.67 M/month at 465 h.
- **DB work per acquisition:**
  - `PowerSystemConfigs.FirstOrDefaultAsync` (`:163-165`). A duplicate/older acquisition returns after only this read (`:167-175`).
  - `Outlets.ToListAsync()` (all 5 rows, `:195`).
  - Conditional latest-event read when state is Warning/Critical (`:395-397`).
  - One `SaveChanges` (`:410`): UPDATE `PowerSystemConfigs` (acquisition sequence/metering mode, every batch); INSERT 4 branch `TelemetryReadings` plus 1 USB mirror row plus 1 `InaReadings` row (`:210-218,236-243,257-265`); UPDATE up to 5 outlets (`CurrentWatts`/`LastSeen`/status/command fields); optional `PowerEvents` INSERT. EF `RETURNING` brings back generated IDs.
  - About 3–4 round trips, of which about 2 are for the implicit transaction. **R**.
- **No device / no admins / no buffer:** no / yes / not applicable (every request carries data).
- **Cache:** none. **Retry:** X-2; `SaveChanges` retries as a unit. **Connection:** pooled. **Transaction:** a single implicit `SaveChanges` transaction (milliseconds). The reads before it are outside the transaction.
- **Extends window:** yes, continuously while the device is online.
- **Owner:** **E** (runtime ingest, bounded buffer, batch-window flush; latest-event read replaced by runtime state). **D** provides hydration and post-commit publication for control transitions.

#### W-07 Dashboard current state — `GET /api/Dashboard/state`

- **Where:** `Dashboard.cs:39,56-70`: 5 s absolute `IMemoryCache` entry `dashboard:state`, shared by all users and evicted by every mutation endpoint (`:181-277`). Handler: `src/Application/Power/Queries/GetDashboardState/GetDashboardState.cs:127-243`.
- **Callers (S):**
  - `App.tsx:42,159-185`: every 2 s after the previous response, while signed in; it skips hidden tabs but keeps its timer. It is mounted for **every** view.
  - `PoliciesView.tsx:48-69`: `setInterval` every 15 s with **no `document.hidden` check**.
  - `PolicyAdminView.tsx:251`: on load/save.
  - `TelemetryView.tsx:87-100`: once on mount.
- **DB work per cache miss:** outlets (`:129-131`); config (`:133-135`); latest 20 events (`:154-158`); 30-second mains-voltage `AVG` over `TelemetryReadings` (`:177-181`); latest INA sample (`:189-192`). That is 5 SELECTs plus the W-12 identity lookup, about 6 round trips. Expected rows: about 5 + 1 + 20 + 1 aggregate + 1.
- **Cadence on Neon:** with one visible tab, a miss roughly every 6 s (2 s poll against a 5 s TTL). Three admins share the key, but concurrent misses are not single-flight (X-6). **R**.
- **No device / no admins / no buffer:** yes / no / yes.
- **Cold-miss behaviour:** the first poll after any restart, mutation or TTL expiry runs the full query set. **Retry:** X-2. **Transaction:** none.
- **Extends window:** yes, continuously while any signed-in tab is visible (and while a Policies view is open even when hidden).
- **Owner:** **D** (snapshot-served current state; the endpoint cache is removed on that path). D's zero-query gate also depends on W-12.

#### W-08 History series — `GET /api/Dashboard/telemetry`

- **Where:** `Dashboard.cs:40,81-126`. Cached per `window`+`channels`, TTL 30 s (`15m`), 1 min (`1h`, `6h`), 5 min (`24h`), 10 min (`7d`) (`:104-111`). Handler: `src/Application/Power/Queries/GetTelemetrySeries/GetTelemetrySeries.cs:175-…`.
- **Callers (S):**
  - `Dashboard.tsx:53,96-141`: `15m` every 30 s; hidden ticks skip the fetch but keep the timer.
  - `TelemetryView.tsx:115,180-207`: the selected window every `POLL_INTERVAL_MS` (`data/telemetry.ts:20-26`: 30 s/60 s/60 s/300 s/none), plus a reload whenever the tab becomes visible.
- **DB work per miss:** metadata plus metering-mode subquery (`:200-210`); one aggregate over raw `TelemetryReadings` **UNION ALL** `TelemetryReadingRollups` (`:230`); plus W-12. Result volume is bounded by buckets (≤ about 361 × channels rows). The scan volume grows with the window. The raw-scan guard at `:287` runs **after** the query has already executed, so it does not limit database work (note for E/F).
- **Cadence on Neon:** because the `15m` TTL (30 s) equals the poll interval, nearly every hero poll is a miss, giving one aggregate about every 30 s per process while a dashboard is visible. **R**.
- **No device / no admins / no buffer:** yes / no / yes.
- **Retry:** X-2. **Transaction:** none.
- **Extends window:** yes, while a dashboard or telemetry view is visible.
- **Owner:** **E** (durable-prefix cache plus memory tail merge; no 10-minute concealment); **F** (tier selection once minute rollups exist).

#### W-09 Framework rules — `GET /api/Dashboard/policies`

- **Where:** `Dashboard.cs:41,169-174` → `GetPolicies.cs:30-36` (12 rows).
- **Finding:** `fetchPolicies` (`api.ts:351`) has **no caller** in `components/` (S), so this is not recurring today. The **Policies view** polls `/state` instead (W-07/W-22).
- **Disposition:** no action. If a future UI polls it, it is a D snapshot candidate.

#### W-10 Administrator/control commands

- **Where (all under `Dashboard.cs:42-50`, each plus W-12):**
  - `RequestOutletActivation` (`RequestOutletActivation.cs:34…`): outlet, config, all outlets, 1–2 `SaveChanges`.
  - `DisconnectOutlet` (`DisconnectOutlet.cs:22…`), `ClearOutletRecoveryState` (`:13…`), `AcknowledgeOutletFault` (`:14…`): outlet read plus `SaveChanges`.
  - `ApplySelectiveResponse` (`:72…`) and `RunStagedRestoration` (`:53…`): config plus outlets plus `SaveChanges`.
  - `SetManualOverride` (`:50…`): event INSERT.
  - `UpdateOutletPolicy` (`:62…`) and `UpdateThresholds` (`:55…`): one read plus `SaveChanges`.
- **Trigger:** operator action only; not recurring. Each evicts the state cache, so the next 2 s poll is a W-07 miss.
- **No device / no admins / no buffer:** yes / no / yes.
- **Retry:** X-2. **Transaction:** one short implicit `SaveChanges` transaction per command.
- **Extends window:** briefly; each action is a wake when Neon is suspended. This is **required**: control transitions must stay immediately durable.
- **Owner:** **D** (serialized mutation coordinator, post-commit publication). No G action.

#### W-11 Authentication

- **Where:** `src/Web/Endpoints/Users.cs:12` (`MapIdentityApi`). The SPA calls `POST /api/Users/login?useCookies=true` (`api.ts:507-512`) and `GET /api/Users/manage/info` on tab restore (`App.tsx:104-118`, `api.ts:502-505`). Logout (`Users.cs:19-28`) does no DB work.
- **DB work:**
  - Login: user lookup, password verification, lockout/access-failed bookkeeping (may UPDATE), and principal creation (claims/roles).
  - `manage/info`: user lookup.
  - Security-stamp revalidation: every 30 min per session (X-5). **R**: exact counts.
- **No device / no admins:** yes / no.
- **Extends window:** yes, at login, at tab restore, and every 30 min per active session.
- **Owner:** **G attributes only.** Spec G forbids bypassing Identity, authorization or security-stamp validation. A must bucket these under *Authentication*.

#### W-12 MediatR identity lookups (hidden per-request query)

- **Where:** `LoggingBehaviour.cs:27-30` (every request) and `PerformanceBehaviour.cs:37-46` (requests over 500 ms), registered at `src/Application/DependencyInjection.cs:24,28`. Each call goes to `IdentityService.GetUserNameAsync` → `UserManager.FindByIdAsync` (`src/Infrastructure/Identity/IdentityService.cs:25-30`).
- **Trigger:** every authenticated `ISender.Send`: W-07/W-08/W-09 cache misses, W-10 commands, and scenario ingest. Cache **hits** at the endpoint never reach MediatR and skip it.
- **DB work:** 1 SELECT on `AspNetUsers` by key (2 if slow). The result is used only for a log line.
- **Why it matters:** Spec D removes the 5 s state cache on the snapshot path. If the snapshot read is still dispatched through MediatR, every 2 s poll by every administrator costs one `AspNetUsers` query. That is a recurring query D's acceptance ("zero recurring state queries") cannot pass with. A slow Neon wake (over 500 ms) doubles it.
- **No device / no admins:** yes / no.
- **Owner:** **unassigned.** `src/Application/Common/Behaviours/*` is in no wave's file list. Needs a coordinator decision (§6, item U-1).
- **Fix shape, for the assignee to confirm:** take the user name from the authenticated principal's claims (`ClaimTypes.Name`/email are already in the Identity cookie), with no database lookup. This is logging-only data; authentication and authorization are untouched. Test: with A's interceptor, 1,000 authenticated `GetDashboardStateQuery` dispatches on the snapshot path produce zero `AspNetUsers` commands.

#### W-13 Health checks — `/health`, `/alive`

- **Where:** `src/ServiceDefaults/Extensions.cs:92-99` registers only `self` (tag `live`). Aspire enrichment (`DependencyInjection.cs:35`) adds a DbContext check named after the context type with **no tags** (S-pkg: `TryAddHealthCheck`, `AddDbContextCheck`). The endpoints are mapped only when `IsDevelopment()` (`Extensions.cs:101-118`).
- **Development:**
  - `/health` runs all checks, including `DbContextHealthCheck` → `Database.CanConnectAsync`. The Npgsql EF provider's existence check uses an **unpooled** clone of the connection string (S-pkg: the provider assembly contains `set_Pooling`/`set_Multiplexing`/`CloneWith`; **R** to confirm), so **each `/health` call is a new physical connection (TCP + TLS + auth) and therefore a Neon wake**.
  - `/alive` runs only `self`. **Confirmed non-issue.**
- **Production:** neither endpoint exists. `GET /health` falls through to `MapFallbackToFile("index.html")` (`Program.cs:90`) and returns 200 with HTML and no DB access (S; **R** to confirm). `docs/DEPLOYMENT.md:82` ("the `/health` endpoint returns `Healthy`") is therefore wrong for Production.
- **Platform probes:** Render's configured health-check path and interval are **X**.
- **Owner:** **G** (G-1, G-2, G-7).

#### W-14 Aspire Npgsql database enrichment

- **Where:** `DependencyInjection.cs:35` (`builder.EnrichNpgsqlDbContext<ApplicationDbContext>()`), no settings override.
- **Effects:** retries (X-2), the DB health check (W-13), Npgsql/EF tracing and metrics. Metrics and tracing are in-process instrumentation and issue no SQL (S-pkg / **R**). There is no keepalive or periodic ping in its documented surface.
- **Owner:** G verifies. Spec G permits disabling only demonstrated recurring pings. Retries are failure-only, so **keep them** unless measurement shows retry storms during wake.

#### W-15 Connection keepalive and pool behaviour

- **Finding:** no keepalive is configured in code (X-1). The idle pool prunes physical connections after about 300 s **without SQL**. The URL-form normalization strips unknown parameters. The key/value form is passed through, and the hosted secret is **X**.
- **Open question (R):** whether an idle-but-open pooled connection, with no queries, delays Neon suspension. Neon defines inactivity by queries, but G must confirm on LoadWise (console compute graph or monitoring) without running SQL probes in the quiet interval.
- **Owner:** G verifies (G-3). No code change is expected. `NormalizePostgresConnectionString` is in an F-owned DI file in Wave 4; if a change proves necessary, hand it to F.

#### W-16 Health-check publisher

- `AddHealthChecks` registers `HealthCheckPublisherHostedService`, but it does nothing without an `IHealthCheckPublisher`. None is registered in `src/` (S: grep), and neither the OpenTelemetry nor the Aspire packages used here add one (**R**: confirm via the hosted-service list). **Confirmed non-issue.**

#### W-17 Developer exception page database filter

- `src/Web/DependencyInjection.cs:13` (`AddDatabaseDeveloperPageExceptionFilter`). In Development, when an unhandled database exception reaches the developer exception page, the filter inspects migration state, which is extra DB work on the **error path only**. This is not recurring and not active in Production. **Non-issue**; documented so a measurement spike on an error is attributable.

#### W-18 Aspire AppHost (local run mode)

- `src/AppHost/Program.cs:10-30`. The database is an external connection-string resource with no health check. The Web resource has no `WithHttpHealthCheck`. The frontend `WaitFor(web)` waits on resource state, not on an HTTP or DB probe. The Vite dev proxy (`ClientApp/vite.config.ts`) forwards `/api` only. **Confirmed non-issue.** The ACA environment (`:5`) only matters for an ACA publish; if that path is ever deployed, its generated probes must be audited (**X**).

#### W-19 Process restarts, deploys, host sleep/wake

- **Static:** every start repeats W-01 and W-02. `LoadSheddingStateStore` is in-memory (`src/Application/Power/Services/LoadSheddingStateStore.cs:22-45`) and resets. `IMemoryCache` starts empty, so the first state/history polls are misses. Cookies may be invalidated (X-5), forcing a W-11 login.
- **External (X):** how often Render restarts or sleeps the instance, and whether deploys overlap. An overlapping deploy would briefly run **two** processes: two W-04 timers, two ingest writers, and concurrent migrations. `docs/DEPLOYMENT.md:10,41-42` asks for one instance but does not require stop-before-start. This feeds D's single-writer guard and documentation (Spec D §8).

#### W-20 External monitoring and platform probes

- None tracked in the repository. Any Render health check, uptime pinger or synthetic monitor is **X**. A probe that targets `/health` or `/alive` in Production costs no DB work. A probe that targets any `/api/*` route other than the device filter's rejection path would.
  - `/api/Device/*` with a configured key returns 401 without DB.
  - `/api/Dashboard/*` without a cookie returns 401 without DB.
- **Owner:** user action. Recommendation: point any platform health check at the DB-free liveness path from G-1.

#### W-21 Unmounted frontend pollers (latent)

- `ChannelInventoryView.tsx:320-362` (state plus `15m` history every 30 s) and `ScenarioPanel.tsx:515-596` (`15m` history every 10 s, state every 30 s) contain polling loops, but neither component is rendered: only `import type { ScenarioNotice }` references exist (`Dashboard.tsx:11`, `DashboardSimRail.tsx:1`). There is **no traffic today**. If either is mounted again, it adds W-07/W-08 load. Frontend files are outside every wave's ownership. Recorded for awareness.

#### W-22 Policies view polls while hidden

- `PoliciesView.tsx:67`: `setInterval(load, 15000)` without a `document.hidden` check, on top of the App-level 2 s state poll. It is harmless to Neon once D serves state from memory **and** W-12 is resolved. Otherwise each poll can be a miss plus an identity query. Frontend edits are not planned (Spec E "No frontend edits"), so this needs a coordinator decision only if W-12 stays unresolved.

#### W-23 Template endpoints

- `TodoItems.cs`, `TodoLists.cs` (DB) and `WeatherForecasts.cs` (no DB) are mapped but have no SPA caller (S: grep). They run on request only. **Non-issue.**

## 5. Confirmed non-issues (G must not "fix" these)

| Item | Why it is not a wake source | Evidence |
|---|---|---|
| `self` liveness check, `/alive` predicate on tag `live` | `HealthCheckResult.Healthy()` lambda; no I/O | S: `ServiceDefaults/Extensions.cs:94-96,111-114` |
| Health-check publisher hosted service | No publishers registered → idle | S (grep), W-16 |
| OpenTelemetry metrics/tracing/logging, OTLP exporter | In-process. The exporter sends to a collector only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, never to Postgres | S: `Extensions.cs:44-90` |
| HTTP client resilience/service discovery | Applies to `HttpClient` only; no `HttpClient` is used in `src/` | S: `Extensions.cs:24-33`; grep |
| Azure Key Vault configuration | Only when `AZURE_KEY_VAULT_ENDPOINT` is set; not DB | S: `src/Web/DependencyInjection.cs:36-45` |
| Device API-key filter | Configuration string comparison | S: `DeviceApiKeyEndpointFilter.cs:22-39` |
| Static files, SPA fallback, OpenAPI JSON, Scalar UI | No DB access | S: `Program.cs:79-90` |
| Logout | Cookie sign-out only | S: `Users.cs:19-28` |
| Npgsql connection keepalive | Off by default; not configured | S: X-1 (hosted string **X**) |
| AppHost resources | No DB probes | S: W-18 |
| Data protection | Not DB-backed (only the cookie-invalidation side effect, X-5) | S: grep |

## 6. Ownership classification

| Owner | Findings | Notes |
|---|---|---|
| **D** — runtime hydration, current reads, post-commit publication | W-05, W-07, W-10; hydration/publication parts of W-06 | D's zero-query gates also require U-1 (W-12). |
| **E** — steady ingest, batching, tail merge, batch-window scheduling | W-06, W-08 (tail merge, cache constraints), adaptation of W-04 to `IHistoryMaintenance` | The latest-event read (`IngestTelemetry.cs:395-397`) moves to runtime state. |
| **F** — retention execution, catch-up, compaction | W-04; W-08 tier selection; optional W-02 seeder N+1/no-op-write reduction | F owns `ApplicationDbContextInitialiser.cs` and the DI files in Wave 4. |
| **G** — remaining startup/probe/connection/monitoring | W-01, W-02 (verify only), W-03, W-11 (attribution), W-13, W-14, W-15, W-16, W-17, W-18, W-19, W-20 | Finite action list in §7. |
| **Unassigned — coordinator decision** | **U-1:** W-12 (`src/Application/Common/Behaviours/LoggingBehaviour.cs`, `PerformanceBehaviour.cs`). **U-2:** W-21/W-22 (frontend). **U-3:** `MUST_READ.md` §4 still states 5 s telemetry / 15 s config, while the firmware is 1 s / 500 ms. | U-1 blocks D's acceptance and should be assigned to D for Wave 2. U-2 needs action only if U-1 is not fixed. U-3 is documentation only; `MUST_READ.md` must not be "cleaned up" before 31 Oct 2026 (its own header). |

## 7. G action list (finite)

Every item names the permitted files (Spec G ownership), expected behaviour, flag interaction and an observable test. "A's interceptor" means Spec A's `TelemetryDatabaseInterceptor`/metrics, enabled with `Telemetry:Measurement:Enabled=true` in tests only. With `Telemetry:QuietDatabaseMode=false`, which is the default including when configuration is absent, every item below must leave behaviour unchanged.

| # | Finding | Permitted files | Expected behaviour | Flag interaction | Verification |
|---|---|---|---|---|---|
| G-1 | W-13 liveness | `src/ServiceDefaults/Extensions.cs` | Keep `self` as the only `live` check. Under quiet mode, map `/alive` (tag `live` only) in **all** environments so platforms have a DB-free liveness target. Never tag a DB check `live`. | Off: today's mapping (Development only). On: `/alive` mapped in every environment. | `QuietDatabaseTests`: 1,000 `GET /alive` with quiet mode on → **0** DB commands and 0 connection opens (A's interceptor). With the flag off in `Production`, `/alive` is still unmapped (falls through to the SPA). |
| G-2 | W-13/W-14 DB readiness | `src/Web/Program.cs` (set `Aspire:Npgsql:EntityFrameworkCore:PostgreSQL:DisableHealthChecks=true` in configuration before `AddInfrastructureServices` when quiet mode is on); `src/ServiceDefaults/Extensions.cs`; `src/Infrastructure/Power/QuietDatabase*.cs` | Under quiet mode, `/health` reports **runtime** readiness from memory (D's snapshot hydrated; E's persistence status not breached) instead of opening a DB connection. A hydration failure or a breached loss guarantee returns `Unhealthy`, so the real state is never hidden. Document the wake cost of any on-demand DB check retained elsewhere. | Off: Aspire DB check unchanged. On: DB check disabled; runtime readiness check registered via `QuietDatabaseRegistration`. | 100 `GET /health` with quiet mode on → 0 DB commands and 0 physical connections. With a failed hydration (D's test hook) → HTTP 503/`Unhealthy`. With the flag off in Development → the DB check still runs (one connection per call, recorded as the baseline). |
| G-3 | W-15 keepalive/pool | None expected (verify only). `src/Infrastructure/DependencyInjection.cs` is F's; hand any change to F. | Confirm `KeepAlive=0`, `TcpKeepAlive=false`, `MinPoolSize=0` on the normalized connection string for both the URL and key/value forms, using **synthetic** inputs. On LoadWise, confirm the compute suspends while the process holds an idle pool. | None | Unit test in `QuietDatabasePolicyTests` over synthetic connection strings (no real secrets, nothing printed). Rehearsal: Neon console shows suspension within about 5 min of the last query while the process stays up (G-10). |
| G-4 | W-01/W-02/W-03 startup | `src/Web/Program.cs` (verify; change only if a defect is found) | Initialization runs exactly once per process start and before request handling. Build-time doc generation performs no DB initialization. Migration/seed correctness is unchanged. | Unaffected by the flag. | Integration test: host start with A's interceptor → startup commands are attributed to *Startup*, then **0** commands for a fixed quiet interval with no clients (accelerated clock where E/F timers allow). `dotnet build src/Web` with `ConnectionStrings__Mor.PowerManagementDb` pointing at an unroutable synthetic host succeeds with zero connection attempts. Revert the regenerated `v1.json` unless G is committing the final one. |
| G-5 | W-04 single maintenance timer | `src/Infrastructure/Power/QuietDatabasePolicy.cs` (startup validation); F adds the registration call | Quiet mode is rejected at startup unless cached reads, runtime ingest and batch persistence are on, **and** the legacy `TelemetryRetentionService` is not running alongside E's `BatchWindowCoordinator`. | On: validation enforced. Off: no validation. | `QuietDatabasePolicyTests`: invalid flag combinations throw at startup. Integration: enumerate `IHostedService` instances with quiet mode on → no independent DB timer. Empty off-hours interval of ≥2 × flush interval → 0 maintenance queries (E/F acceptance reused). |
| G-6 | W-11/W-12 attribution | None (measurement only) | Login, `manage/info`, security-stamp revalidation and any remaining MediatR identity lookups are attributed to *Authentication* in A's categories and included in the activity budget. No bypass. | None | Timeline test: 1 and 3 authenticated pollers over 35 min (accelerated) → state/config categories show 0 recurring queries. Authentication shows the expected revalidation per session. If U-1 is unresolved by Wave 4, report it as a **blocker**, not a G fix. |
| G-7 | Documentation discrepancies | `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` | Correct: `DEPLOYMENT.md:82` (`/health` is not mapped in Production; name the quiet-mode liveness path); `DEPLOYMENT.md:71-78` (availability vs Neon idle windows; one active backend, stop-before-start); `ARCHITECTURE.md:12,125` (device cadence is 1 s telemetry / 500 ms config, not 5 s); `ARCHITECTURE.md:141-145` (retention after F). Preserve the temporary-rig instructions. | n/a | Review against this audit; every corrected statement cites its source line. |
| G-8 | W-18 AppHost | `src/AppHost/Program.cs` (verify only) | No DB probe added. If G adds `WithHttpHealthCheck`, it must target the G-1 liveness path, never `/health` with a DB check. | n/a | Code review plus a test that the AppHost model contains no health check on the database resource. |
| G-9 | W-20 external probes | none (user action) | Record the Render plan, health-check path/interval and any pingers once the user supplies them. Recommend to the user that the platform health check target the G-1 liveness path. Production is not touched by workers. | n/a | Final disposition table in `docs/NEON_WAKE_VALIDATION.md` marks each item verified or **pending (X)**. |
| G-10 | Suspension proof | `docs/NEON_WAKE_VALIDATION.md` | On LoadWise, with all four flags on, capture real suspension/resume timestamps across at least one full 15-minute batch cycle, with no SQL probes during the quiet interval. Distinguish DB suspension from backend-host sleep. | All flags on, rehearsal only. | Neon console/monitoring timestamps; compute projection from the union of active intervals at 0.25 CU against the ≤75 CU-h/month gate. Mark the gate pending/failed if it cannot be captured. |

## 8. Scenario view (static expectation today; to be reconciled with A)

| Scenario | Wake sources active at `54c4885` | Expected after D/E/F/G (target) |
|---|---|---|
| No device, no administrators, host up | W-04 every 15 min (≥⅓ duty); W-19 on restarts | Only E/F batch-window maintenance when there is work; no recurring empty-window query. |
| Device only, steady (no transitions) | W-05 (4 SELECT/s) + W-06 (about 3–4 round trips/s) + W-04 | Zero reads/writes between 15-minute flushes after hydration (E gate). |
| 1 administrator (dashboard visible) | + W-07 miss about every 6 s (about 6 round trips) + W-08 `15m` about every 30 s (+ W-12 on each) + W-11 every 30 min | State served from memory (D). History durable component cached; tail merged from memory (E). Authentication only. |
| 3 administrators | Same keys shared, but non-single-flight misses can multiply (X-6); 3× W-11 | As above; authentication scales per session. |
| History cache miss (`1h`/`6h`/`24h`/`7d`) | W-08 aggregate over raw + rollups | Constrained to the committed boundary; minute/five-minute tiers (F). |
| Control-transition storm | W-06 writes every second + W-10 + W-07 evictions | Immediate durable transactions remain (by design); everything else is unchanged from the steady path. |
| Startup/restart | W-01 + W-02 (about 30–40 round trips) + cold caches + possible re-login | Same plus D's one-shot hydration; bounded to startup. |

## 9. Reconciliation with Spec A (pending)

Spec A's categories map as follows:

| A category | Wake sources |
|---|---|
| Startup/migrations/seeding/hydration | W-01, W-02 (W-03 must be 0) |
| Device configuration | W-05 |
| Telemetry ingest | W-06 (including scenario ingest) |
| Dashboard current state | W-07 |
| History | W-08 |
| Administrator/control actions | W-09, W-10 |
| Authentication | W-11. **Recommend A also buckets W-12's `AspNetUsers` by-key lookups here**, or as a distinct sub-fingerprint, so D's current-state gate is not confused. |
| Retention/checkpoints/bulk persistence | W-04 |
| Health checks | W-13 |
| Unattributed | Anything left must be listed explicitly. Unresolved candidates: W-15 (idle pool vs suspension), W-17 (error path), unexpected platform probes (W-20). |

**Status: pending.** A's baseline measurements were not available when this report was written. Every **R** item above stays unresolved until A's counters (or G's rehearsal) confirm it. In particular:

- the W-02 round-trip count;
- the W-06 round trips per acquisition;
- the W-07/W-08 miss rate with real polling;
- the W-13 unpooled connection;
- the W-04 active window per tick;
- whether W-15 idle pooled connections delay suspension.

## 10. Baseline check run for this slice

Commands run from `Mor.PowerManagement/` with `ASPNETCORE_ENVIRONMENT=Development` and `C:\Program Files\dotnet` on `PATH`:

| Command | Result |
|---|---|
| `dotnet build` (whole solution) | **Failed: 24 errors, all pre-existing NuGet audit errors.** NU1902/NU1903 (warnings-as-errors) for transitive `MessagePack` 2.5.192 in `tests/TestAppHost` and `tests/Application.FunctionalTests`. The central pin `MessagePack 2.5.307` in `Directory.Packages.props` does not apply to those projects. This is an environment/baseline blocker unrelated to this audit. No source was changed. |
| `dotnet build src/Web/Web.csproj` | Succeeded, 0 warnings, 0 errors. It regenerated `src/Web/wwwroot/openapi/v1.json`, which was reverted (`git checkout --`) and not committed. |
| `dotnet test tests/Domain.UnitTests/Domain.UnitTests.csproj` | Passed 6/6 |
| `dotnet test tests/Application.UnitTests/Application.UnitTests.csproj` | Passed 8/8 |

No database, integration-test database, Neon project or production resource was contacted.
