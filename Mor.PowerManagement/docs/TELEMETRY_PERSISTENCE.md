# Runtime ingest and buffered history (PLAN-0001 S0001.3–4)

Wave 3 continues the shared runtime snapshot in `TELEMETRY_RUNTIME.md`.
The implementation is opt-in. All new flags default off, including when
configuration is absent. This document records backend evidence on local
throwaway PostgreSQL, not deployment, Neon suspension, or physical relay safety.

## Flags and startup

- `Telemetry:CachedReadsEnabled=false`: D's original flag.
- `Telemetry:RuntimeIngestEnabled=false`: evaluate ingest from the snapshot.
  Requires cached reads. With batching off, history is still written in the
  ingest request, for staged rehearsal.
- `Telemetry:BatchPersistenceEnabled=false`: queue history and use the bulk
  writer. Requires both other flags. Invalid combinations fail registration
  before the app starts.

Startup order is single-writer guard, migrations/seeding, runtime hydration,
then history checkpoint initialization and one bounded maintenance opportunity.
Requests start afterwards. OpenAPI generation skips initialization. The writer
loads only its two checkpoint rows; it never replays history into the rule engine.
D's single-process, stop-before-start topology restriction still applies.

## Evaluation and durability

The same ingest evaluation body runs on all three paths. Runtime ingest attaches
copies of the captured configuration and outlets as unchanged entities. It
accepts the same known-channel samples, repeated samples, partial INA readings,
and monitor mirror as the baseline. It reads warning de-duplication state from
the latest global runtime event, preserving the five-minute comparison.

An ordinary batched acquisition performs no database command. It updates live
watts, last-seen times, voltage/INA displays, acquisition identity, metering
provenance, relay reports, and framework counters immediately in memory.
`MarkEvaluated` rejects publication if an event or durable outlet/configuration
field changed without a commit.

Changes to outlet status, command IDs, acknowledgements, recovery fields, holds,
or events require an immediate transaction. Its live-state checkpoint and
acquisition safeguards commit together. Only afterwards does the coordinator
publish those durable changes and return success. Failed writes publish nothing
and return an error. The rule engine, thresholds, timers, energy values, firmware,
and polling intervals are unchanged.

Administrator handlers overlay the latest runtime measurements on loaded
entities before making decisions. Those overlaid values are not marked modified
merely because a durable display checkpoint lags memory.

`IngestTelemetryResult.HistoryPersistence` is additive:

- `committed`: synchronous history transaction completed.
- `buffered`: accepted into memory; history is not durable yet.
- `dropped`: live/control evaluation completed, but history exceeded a buffer
  bound and is recorded as a gap.
- `null`: duplicate/older acquisition; nothing was accepted.

`ReadingsStored` retains the baseline per-outlet/mirror count for compatibility;
use the new outcome to determine durability. The separate INA row is additional.
Authenticated `GET /api/Dashboard/telemetry/persistence` exposes watermarks,
active/in-flight counts, allocation estimate, gaps, oldest age, flush records,
shutdown outcome, and persistence acceptance status without querying the database.

## Bounds and scheduling

Settings live under `Telemetry:History`:

- `FlushIntervalSeconds=900`, `FlushLeadSeconds=30`: start the scheduled write
  when the oldest uncommitted acquisition reaches 870 seconds, leaving a normal
  30-second margin within the accepted 15-minute loss boundary.
- `InactivityFlushSeconds=30`: flush the remaining partial batch after inactivity.
- `MaxBufferedAcquisitions=1800`, `MaxBufferedRows=30000`,
  `MaxBufferedBytes=33554432`: shared active plus in-flight bounds.
- `MaxAcquisitionsPerBatch=900`: bounded transaction size.
- `BridgeMaxAcquisitions=1800`: separate bounded committed bridge for charts.
- `ShutdownFlushSeconds=30`: an independent deadline, even if the caller's host
  stopping token is already cancelled.
- `RetryInitialSeconds=30`, `RetryMaxSeconds=300`: exponential retry backoff.
- `MaxOutletSamples=13`, `MaxRelayReports=13`, `MaxRequestBodyBytes=65536`:
  runtime-path request bounds. The HTTP limit applies before JSON binding to
  device and scenario ingest, including Kestrel chunked-body enforcement.

Acquisitions are immutable and shared with the in-flight batch and chart
captures. Conservative accounting includes sample/live-state objects and queue
bookkeeping. Flush serialization prevents simultaneous history writers. The
background writer never takes the runtime sample-evaluation gate.

The scheduler inspects memory every second; an empty buffer executes no flush
or recurring maintenance SQL. Failed batches remain in flight under the same
identity. Overflow retains existing queued rows, continues evaluation and live
publication, and reports cumulative dropped acquisition/row counts and time
bounds in a bounded gap record. The next successful batch persists that gap.
Restart restores the persisted gap report. A recorded gap still fails
persistence acceptance: writing its diagnostic does not restore lost samples.

Oldest exposure includes in-flight time. Exceeding 900 seconds latches a breach
for the process even after a later successful flush. The service does not claim
a strict 15-minute loss bound under a slow writer or outage. An abrupt process
loss discards unflushed memory; there is no durable journal. Restart tests simulate
that loss by constructing a fresh runtime and buffer from the durable database.

## Bulk transactions and uncertain commits

`TelemetryBulkWriter` sends bounded JSON recordsets for outlet/mirror rows and
separate INA rows; PostgreSQL inserts them server-side without returning generated
row IDs. Rows retain the backend acquisition ordinal and sample position, so
repeated channel samples are preserved. A stable batch GUID and highest committed
ordinal advance atomically in the `history` checkpoint.

The `live-state` checkpoint row serializes bulk checkpoints with immediate ingest
transitions. A batch ending before a newer transition cannot overwrite that
transition's live/deduplication safeguards. Next startup reserves ordinals above
both checkpoint streams, including transitions whose history was not flushed.

After commit-success/response-loss, the in-flight batch stays in memory and the
committed watermark does not advance there. Its retry reads the transactional
history watermark under the checkpoint lock, detects the completed batch, and
acknowledges it without inserting again. There is one history retry owner: in
batched mode EF's automatic execution-strategy retries are disabled. An immediate
control transaction is never invisibly replayed after an uncertain commit.

The existing D limitation for an uncertain *control* commit remains: a returned
error can follow an actual durable commit, leaving the snapshot behind the
database until restart. It is not a successful command response. Reconcile/restart
before proceeding after such a control connection failure; this wave's automatic
uncertain-commit recovery covers history batches.

## Chart merge and maintenance contract

The existing `15m`, `1h`, `6h`, `24h`, and `7d` API windows are unchanged.
Only their durable prefix is cached. Every response merges a fresh capture of
active plus in-flight memory with the appropriate retained committed bridge.
Raw database rows are bounded by the captured committed ordinal (legacy null
ordinals remain visible). Prefix, bridge, and tail have disjoint ordinal ranges.

Database and memory contributions retain sums, counts, extrema, maximum existing
energy counter, and latest sample timestamp. They merge before weighted averages,
existing rounding, and existing energy-delta logic. Null buckets, channel
selection, provenance, bin epoch and response bucket counts retain their baseline
semantics. No final merged response is cached on the batched path.

When the bounded bridge no longer reaches a prefix watermark, that prefix reloads.
At most eight prefixes are retained (the five fixed windows normally need five).
Prefix misses capture/read under `HistoryTailMerger.EnterDurableWindowAsync`.
The batch coordinator holds the same gate for maintenance, preventing an older
capture from double-counting newly compacted rows in the unversioned legacy
rollup table. Cached-prefix reads and live evaluation do not wait on that gate.

`IHistoryMaintenance` is F's extension point: initialization catch-up and
successful-flush windows only, outside runtime locks, with a 30-second deadline.
The legacy algorithm temporarily implements it. Its independent timer is inert
in batched mode. F must keep this coordinator/gate and replace the algorithm;
E does not implement seven-day retention or new compaction tiers.

## Migration and rollback

`20261019220000_BufferedTelemetryPersistence` adds nullable identity columns to
raw outlet/INA tables and the checkpoint table. Existing rows remain valid. It
does not drop or recreate the raw-SQL `TelemetryReadingRollups` table or indexes.
The schema-isolation test's expected latest migration name was updated with the
user's approval; all control expectations remain unchanged.

Before changing flags/writers: quiesce incoming acquisitions, call
`BatchWindowCoordinator.DrainAsync`, require success and an empty active/in-flight
buffer, then stop the process and start with the selected flags. A failed drain
stops rollback. A crash-equivalent loss needs an explicit operator decision.
Do not run overlapping writers or down-migrate to roll back behavior.

## Local verification

Run from `Mor.PowerManagement/`, with `ASPNETCORE_ENVIRONMENT=Development` and
`MOR_TEST_DB_CONNECTION` pointing only to the loopback throwaway PostgreSQL.
The existing fixture creates, migrates, verifies and drops only its own isolated
schema; it never starts Aspire or the application seeder.

```powershell
dotnet build src/Web/Web.csproj --no-restore
dotnet test tests/Domain.UnitTests/Domain.UnitTests.csproj
dotnet test tests/Application.UnitTests/Application.UnitTests.csproj
dotnet test tests/Infrastructure.IntegrationTests/Infrastructure.IntegrationTests.csproj
```

Verified locally on 2026-10-20: Web build succeeded with no warnings or errors;
Domain 48/48, Application 61/61, and Infrastructure integration 66/66 tests passed.

Evidence includes zero commands for 100 steady acquisitions plus a duplicate;
900 acquisitions producing exactly 4500 outlet/mirror and 900 INA rows;
commit-success/response-loss retry without duplicate rows; active plus in-flight
acquisition/row/byte bounds through 10000 dropped acquisitions; measured breach
after 901 seconds; responsive evaluation during a paused bulk insert; protection
against an older live checkpoint; inactivity/shutdown partial writes and failed
rollback; restart safeguards/gap reporting; and all five chart windows before,
during and after a flush. Differential traces cover the same 29-action workload
as D, across the three persistence modes. JSON object property order and audit
timestamps are excluded; decisions, values, timer/command identities, event order,
and history counts are compared. B's golden expectations remain authoritative.

Still separate gates: HTTP transport exercise of the body limit, browser
sample-to-screen p95/p99/maximum, real Neon batch/maintenance latency and
suspension, quota/storage/bloat measurements, full-rig capacity, the 72-hour soak,
and physical relay/firmware verification. The known Aspire/MessagePack
full-solution restore/build advisories are outside this slice. No production or
Neon database was accessed for these tests.
