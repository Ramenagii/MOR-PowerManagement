# Telemetry capacity: PLAN-0001 Spec A

Status: measurement instrumentation implemented, default OFF, not merged and not
enabled anywhere. Capacity gates below are NOT complete.
Baseline: 54c48855028fefaa780e4a1954dbf709590329e5. Local work only.

## Measurement method (provider-safe)

An earlier draft wrapped the provider's DbDataReader to count rows. On local
PostgreSQL that failed SaveChanges: Npgsql's modification batch casts the reader
to NpgsqlDataReader and threw InvalidCastException. That approach was removed by
coordinator decision. The interceptor now returns every provider object unchanged
(a test asserts EF receives NpgsqlDataReader) and collects only what EF reports:

| Metric | Source | Exactness |
|---|---|---|
| Command attempts / kind | `ReaderExecuting`, `ScalarExecuting`, `NonQueryExecuting` | Exact for EF-issued commands |
| Success / failure / cancellation | `*Executed`, `CommandFailed`, `CommandCanceled` | Exact for execution outcome (see limits) |
| Elapsed time | EF `CommandExecutedEventData.Duration`; reader-open time from `DataReaderDisposingEventData.Duration` | Exact as EF measures it |
| Reader rows | `DataReaderDisposingEventData.ReadCount` | EF counts `Read()` calls. Upper bound: a fully enumerated query result includes one terminating call that returned `false`. Observed: SaveChanges `INSERT ... RETURNING` counted exactly (1 and 3 rows); a 4-row `ToList` counted 5; a `Single` lookup counted 2; early disposal after 1 row counted 1 |
| Affected rows | non-query result; reader `RecordsAffected` at disposal (covers every statement in a SaveChanges batch) | Provider-reported |
| Scalar rows | 1 if the scalar result is non-null, else 0 | Exact |
| Connection opens / failures | `DbConnectionInterceptor.ConnectionOpened/Failed` | EF opens (pool checkouts), not physical connections |
| Retries | EF `ExecutionStrategyRetrying` event | Only retries performed by an EF execution strategy |
| Estimated result bytes | rows x per-command row width | ESTIMATE, see below |
| HTTP response body bytes | counting response stream in the request middleware | Exact body bytes; excludes headers/TLS |

Estimated database result bytes: per-row width is taken once, when the reader
is returned, from result-set metadata only (`FieldCount`, `GetFieldType`); no
`Read`, value access or enumeration. Width = 7-byte DataRow header + per column
(4-byte length + type width: bool 1, int16 2, int32/float 4, int64/double/
timestamps 8, uuid/numeric/interval 16, text nominal 32, bytea nominal 64,
other 16). Reader estimate = ReadCount x width; scalar estimate uses the
returned value's size. It excludes RowDescription/CommandComplete messages,
protocol framing, TLS, rows the server sent but EF never read, and uses the
first result set's width for multi-result commands. It is NOT Neon transfer.

Not collected, with reason:

- Failures/cancellations that occur while consuming rows AFTER execution
  succeeded: EF's reader closing/disposing events carry no outcome, so such a
  command is recorded as succeeded with the reads made before the error.
  Distinguishing it would require wrapping the reader, which is prohibited.
- Exact rows per result set and actual wire bytes: not available without
  reading values or wrapping the reader.
- Commands issued outside EF interception (direct Npgsql/ADO.NET commands,
  provider-internal SQL, Aspire/Npgsql health or keepalive traffic): invisible
  to EF interceptors. Reconcile with C's NEON_WAKE_AUDIT.md and cloud statistics.

## Scope and baseline sources

Read paths: Infrastructure/DependencyInjection.cs; Web/Program.cs;
Web/Endpoints/{Device,Dashboard}.cs; Application/Power/Commands/IngestTelemetry;
Application/Power/Queries/{GetDeviceConfig,GetDashboardState,GetTelemetrySeries};
Infrastructure/Data/{ApplicationDbContextInitialiser,TelemetryRetentionService};
Infrastructure/Identity; Application/Common/Behaviours; ServiceDefaults/Extensions.cs.
C's NEON_WAKE_AUDIT.md is the cross-check for background and bypassed SQL.

Measurement switch: `Telemetry:Measurement:Enabled`, absent/false by default.
Disabled registration creates no interceptors, registers no services, wraps
nothing, starts no timer, and adds no command. Production config, control formulas, polling and firmware
are outside this slice. Explicit startup scope includes migration/seeding.
HTTP request scopes use fixed categories, not raw paths, IDs or queries.
Identity SQL is separately attributed; retention SQL is recognized without
modifying its schedule. Unknown/background activity remains unattributed until
explained. Later workers should use TelemetryActivityScope.Begin for explicit
background hydration/checkpoint/bulk scopes.

No parameters, connection strings, payloads, cookies, event text or complete SQL
are exported. Labels use bounded hashes and generic table classes. No raw SQL
cache is retained. The local capacity SQL is manually invoked and read-only;
never run it periodically as a monitor.

## Required scenarios and collection method

Capture before/after in-process TelemetryDatabaseMetrics.Snapshot at idle
boundaries. Reconcile command attempts across all categories, command outcomes,
reader rows, non-query affected rows, connection opens, observed EF retries and
estimated database results. Counters are cumulative and not transactional;
snapshot while idle for exact category reconciliation. In-flight commands are
explicit. Database result bytes are the metadata-based estimate described
above; they are unsuitable as entitlement proof.

Run synthetic fixtures against the local throwaway PostgreSQL database first.
Rehearsal cloud correlation requires an independently verified LoadWise target.
Automated tests must not use LoadWise. Never use production to fill evidence gaps.

1. Device-only config + accepted telemetry, including duplicate/older acquisition.
2. One administrator polling current state and config.
3. Three administrators with overlapping polling intervals.
4. Each existing history window and inventory access, cold and cached reads.
5. Transition storm with immediate commands, acknowledgements and event writes.
6. Cold startup, migrations, seeding, hydration and authentication separately.
7. Retention tick, aged rows and repeated insert/delete churn, then idle interval.

Each scenario needs elapsed duration, acquisition count, category command delta,
consumed rows, affected rows, retry/connection delta, database estimate and HTTP
body bytes, plus an explanation for unattributed work. No application scenario
baseline has been captured yet: running the full host (migrations + seeder)
requires B's isolated-schema PostgreSQL harness or the LoadWise rehearsal
destination, so all seven scenarios are PENDING.
HTTP body bytes are backend-to-browser data, excluding headers/TLS. They are
never Neon egress. `pg_stat_statements` provides calls/rows/timing, not network
egress. Direct Npgsql commands, health connections and provider-internal SQL
outside EF interception require separate reconciliation; EF totals alone are
not whole-project activity.

## Storage methodology and row accounting

Use scripts/telemetry-capacity/measure-storage.sql manually at baseline, after
representative inserts, after retention and after sustained churn. Live/dead
counts and reltuples are statistics estimates, not exact counts. Record sample
counts from fixtures, heap/TOAST/index bytes, autovacuum timestamps, dead tuples,
backlog, overlapping migration space, audit/application tables and free headroom.
Subtract empty-table overhead before estimating marginal bytes/row; never infer
steady-state size from a nearly empty relation. Reconcile relation totals with
Neon's project accounting. Extensions and actual cloud statistics remain pending.

The four-branch rig can store FOUR branch TelemetryReadings plus ONE INA mirror
TelemetryReading plus ONE separate InaReading per acquisition: SIX raw rows,
not five. The mirror does not replace the diagnostic row. At 1 Hz and 15 powered
hours/day, seven calendar days yield 1,890,000 telemetry rows plus 378,000 INA
rows = 2,268,000 raw rows. At the historical 5-second cadence divide these counts
by five; it does not authorize changing firmware. Missing/partial INA and outlet
validation can reduce actual rows; derive the profile from accepted fixtures.

At 1 Hz, 465 operating hours/month means 1,674,000 acquisitions/month. Current
six-row profile: 10,044,000 raw row inserts/month before compaction/deletion.
A 24-hour/day profile has 744 operating hours/month, a factor of 1.6.
For H extra monthly powered hours add 3,600*H acquisitions and 21,600*H raw rows
for this six-row profile. Seven-day storage depends on the rolling seven-day
power profile, not merely monthly averages.

Illustrative planning ONLY, using 160 bytes per raw row including indexes and
256 bytes per summary row: six raw rows/acquisition imply 362.88 MB for seven
days at 15 hours/day, plus 31.7952 MB for six one-minute series aged 7-30 days
and 8.2944 MB for six five-minute series for 30 days = 402.9696 MB.
This conservatively treats all six storage series as summarized independently;
F must confirm the approved diagnostic aggregate schema. None exists yet for INA.
At 24 powered hours/day this illustration becomes 644.75136 MB before all
application/audit/backlog/bloat exclusions. At 256 bytes/raw row, seven-day raw
alone is 580.608 MB (15 h/day). These are not measured capacities.

Thirteen displayed series with a duplicated INA diagnostic imply FOURTEEN raw
storage rows per acquisition: 5,292,000 raw rows/7 days, or 846.72 MB at 160
bytes/row. With fourteen equivalent minute/five-minute summary series the
illustrative total is 940.2624 MB before exclusions. If thirteen refers to
thirteen branch outlets PLUS monitor mirror PLUS diagnostic, count FIFTEEN
storage series instead: 1,007.424 MB under the same assumptions.
The full-rig identity/count is pending; do not select one interpretation silently.

Storage gates: investigate at 750 decimal MB; measured steady-state total must
be <=800 MB under a confirmed 1 GB entitlement. Full-rig seven-day acceptance
is NOT established; bring measured failure to the user without choosing the
three-day fallback. Individual audit/control records remain >=30 days per the
approved revision. Preserve existing five-minute history and energy semantics.

## Compute and transfer budgets

Planning assumptions: 0.25 CU, four isolated batches/hour, five idle minutes
per wake. At 465 hours/month: 1,860 batches, 38.75 CU-hours before work duration;
with one/two/five minutes of work per batch: 46.50/54.25/77.50 CU-hours.
At 744 hours/month: 62.00/74.40/86.80/124.00 CU-hours respectively.
Each extra powered hour adds 0.083333 CU-hours before work, or 0.116667 with
two-minute batches. Include startup, auth, history and event wakes using their
union of active time (do not double-count overlaps). Gate <=75 CU-hours/month;
batch/maintenance duration <=2 minutes. Actual sleep/resume evidence pending.

Parent allocation in decimal GB/month: startup/hydration/auth 0.20; batch,
checkpoint and immediate control 0.80; history misses 0.75; maintenance and
monitoring 0.25; margin 1.00. Total <=3.00 against the stated 5 GB allowance.
For each category reconcile calls*cloud-measured bytes/call with cloud deltas.
Neither HTTP JSON size nor coarse field estimates can establish this gate.
The reported 265 MB/day baseline is unverified; if confirmed it means 8.215
GB/month and needs a 63.5% reduction to reach 3 GB. At 24-hour operation,
projections require measured workloads; multiplying the powered portion by 1.6
is sensitivity, not a claim that all traffic scales equally.

## Unresolved evidence and release status

Cloud entitlement/reset/suspension reason, production deployed SHA, firmware
build/cadence, LoadWise project settings and pg_stat_statements availability,
Render tier/health path/pingers, actual bytes/call, sustained storage/bloat,
72-hour soak, and real suspend/resume timestamps: PENDING, not verified here.
Handoff values are historical context only. No cloud contacted or migrated.
No capacity gate is complete. A, B and C merge acceptance remains pending.

## Local verification (2026-10-19)

Local throwaway PostgreSQL 18 (`mor-test-pg`, 127.0.0.1:55432, test-only
credentials), temporary tables only; no migrations, seeder, Neon or production.

- `dotnet test tests/Application.UnitTests/Application.UnitTests.csproj --filter
  "FullyQualifiedName~TelemetryMeasurement"` with `MOR_TEST_DB_CONNECTION` set:
  22/22 passed (Application project total with the database set: 30/30; without
  it the real-provider test is skipped, 29 passed, 1 skipped). The real-provider test proves:
  EF receives `NpgsqlDataReader`; SaveChanges `INSERT ... RETURNING` (1-row and
  3-row batches), SaveChanges `UPDATE`, raw non-query, real scalar, queries,
  early reader disposal and execution cancellation all behave normally and the
  connection stays usable afterwards; one failing reader, scalar and non-query
  are each counted once; the cancellation is counted as canceled; total
  attempts equal an independent probe interceptor's count; no command is left
  in flight; no fingerprint or emitted metric tag contains the fixture secret
  or the connection password.
- Disabled (absent or `false`): no services registered, no DbContext options
  extension added, therefore zero additional commands.
- Baseline Domain tests 6/6 and Application tests (excluding the new fixture)
  8/8 continue to pass.
- Full-solution `dotnet build` fails on 24 pre-existing NU1902/NU1903
  MessagePack 2.5.192 advisories in TestAppHost/Application.FunctionalTests.
  Not fixed in this slice; affected projects are built and tested individually.
- Storage SQL re-executed read-only (exit 0) via `docker exec -i mor-test-pg psql -U mor_test
  -d mor_test -v ON_ERROR_STOP=1 -f -`. That database had no persistent user
  tables and no pg_stat_statements, so this validates script syntax only, not
  application row/storage size.
