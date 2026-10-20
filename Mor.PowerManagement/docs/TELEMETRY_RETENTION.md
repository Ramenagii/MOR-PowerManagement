# Seven-day raw retention and minute compaction (PLAN-0001 S0001.5)

Wave 4 builds on the buffered history in `TELEMETRY_PERSISTENCE.md`. It is
opt-in and defaults off, including when configuration is absent. This document
records backend evidence on local throwaway PostgreSQL, not deployment or Neon
behaviour.

## Flag and startup

- `Telemetry:RetentionV2Enabled=false`: keep raw telemetry for seven days and
  compact older raw rows into per-minute summaries.
- Enabling it requires `Telemetry:RuntimeIngestEnabled=true` and
  `Telemetry:BatchPersistenceEnabled=true`. Any other combination fails
  registration before the app starts and names the flag.
- The retention windows are fixed by the plan, not configuration. While V2 is
  on, the legacy `Telemetry:RawRetentionHours` and
  `Telemetry:RollupRetentionDays` keys are ignored. If either is present,
  a warning names them once, but never their values.
- Only batch sizes are tunable, under `Telemetry:RetentionV2`:
  `CompactionBatchRows` (50,000), `PruneBatchRows` (10,000) and
  `MaxBatchesPerRun` (20). Non-positive values fail startup.

With the flag off, nothing changes. E's `legacy-retention` maintenance job
keeps the six-hour raw window and 30-day five-minute rollups, no event is
deleted, and the new tables stay empty.

## What is kept

| Data | Kept | Where |
| --- | --- | --- |
| Raw outlet readings | at least 7 days | `TelemetryReadings` |
| Raw INA226 readings | at least 7 days | `InaReadings` |
| Per-minute outlet summaries | through day 30 | `TelemetryMinuteRollups` |
| Per-minute INA226 summaries | through day 30 | `InaMinuteRollups` |
| Five-minute outlet summaries | through day 30 | `TelemetryReadingRollups` (raw-SQL table, unchanged shape) |
| Control and audit events | each one individually, at least 30 days; newest 20 always | `PowerEvents` |

The raw cutoff is `now − 7 days` floored to the minute, so a minute is never
split between raw and summary. Each minute summary keeps the count, sums,
minimum and maximum of voltage, current and power, and the first, last and
maximum energy with their timestamps. First and last are ordered by timestamp,
then acquisition ordinal, then sample ordinal, then id. INA226 summaries keep a
separate count per field because firmware can omit a field. A missing value is
no contribution, not zero.

Event retention follows approved revision B. Unresolved operational state
(holds, pending or unacknowledged relay commands, recovery episodes) lives on
the `Outlets` and `PowerSystemConfigs` rows. Retention never touches those rows,
so no event needs a state exemption. Every `PowerEvent` is a closed log entry.

## How it runs

V2 replaces E's legacy job with one `retention-v2` `IHistoryMaintenance` job.
It has no timer of its own and runs only inside E's maintenance windows (startup
initialization and after a non-empty flush), within the window's deadline. Each
window runs these steps in order:

1. Compact outlet raw rows older than the cutoff.
2. Compact INA226 raw rows older than the cutoff.
3. Prune minute and five-minute summaries older than 30 days.
4. Prune events older than 30 days, keeping the newest 20.

Each compaction batch is one transaction. It locks the stream's row in
`TelemetryCompactionCheckpoints` with `FOR UPDATE SKIP LOCKED`, deletes up to
`CompactionBatchRows` of the oldest raw rows with `RETURNING`, and upserts them
into the minute and five-minute buckets. It then advances the checkpoint
counters. A failure anywhere rolls back the delete, the summaries and the
progress together. Because the raw rows are consumed by the same commit, a
retry, or a commit whose response was lost, finds nothing to count twice. A
second runner that finds the stream locked skips it (`Busy`) and makes no
changes. Work that misses the deadline or the batch budget is `Deferred` to the
next window. A late upload older than seven days merges into its existing
minute and five-minute buckets.

## History queries

`GetTelemetrySeries` is unchanged. Its longest window (7 days) starts after the
raw cutoff, so with V2 on every window reads raw rows plus the recent tail, and
compaction never changes a result. Rows older than the raw boundary are still
read from five-minute rollups, which V2 keeps writing into the same buckets.
The minute tier is stored but not read by any current window, so nothing is
counted twice.

## Cutover and rollback

- **Cutover.** Before cutover, the legacy job already compacted everything
  older than six hours into five-minute rollups, and V2 leaves those alone.
  Raw history therefore builds back up to seven days over the first week.
  Minute summaries exist only from the first row V2 compacts.
  `TelemetryCompactionCheckpoints.MinuteCoverageFromUtc` records that point.
- **Rollback.** Turn the flag off. The legacy job resumes its six-hour window
  and compacts the retained raw rows into five-minute rollups. Query results
  for the 24 h and 7 d windows match the V2 results within floating-point
  tolerance. The minute tables and checkpoints are left in place, unread, and
  are not pruned while V2 is off. Re-enabling V2 resumes from the checkpoint.

## Migration

`20261020090000_TelemetryMinuteRetention` is additive. It creates
`TelemetryMinuteRollups`, `InaMinuteRollups` and
`TelemetryCompactionCheckpoints`. It keeps the raw-SQL
`TelemetryReadingRollups` table, its rows and its indexes. It changes the
history foreign keys from `TelemetryReadings`, `TelemetryReadingRollups` and
`TelemetryMinuteRollups` to `Outlets` to `ON DELETE RESTRICT`. Deleting an outlet
that still owns history now fails (SQLSTATE 23001) instead of cascading. Its Up
step contains no table, column or index drops.

The migration and the restrict rule apply whether or not the flag is on. No
application command deletes outlets; the only code path that did was the seeder,
which is now guarded (below).

## Rollout implications

After this migration, a seeded roster change that would remove or re-key an
outlet with retained history stops startup instead of deleting that history or
relabelling it as another channel. Retained history means raw, minute or
five-minute rows. The error names the outlet id and name and the reason, never
connection details. An outlet with no history is still relabelled or removed as
before, and the current testing-rig seed re-runs cleanly over existing history.

Example: switching the seeder from the testing rig to the full rig re-keys
`USB 1` from `INA226 monitor` to `Relay CH10`. If outlet 5 (`USB 1`) has
retained history, startup stops with
`Outlet 5 ('USB 1') has retained telemetry history; …`. The operator must
decide what happens to that history (export, keep under a new outlet id, or
delete deliberately) before the roster can change.

The underlying roster and channel mismatch between the seeder and the firmware
is out of scope for PLAN-0001. This slice adds only the history-identity
safeguards.

## Capacity evidence

`RetentionCapacityTests` measures the footprint on local throwaway PostgreSQL 18.
It is `[Explicit]`, so it runs only when named. The load is the full rig without
USB: 8 × 220 V and 1 × 110 V channels, plus the INA226 mirror outlet row
(10 outlet rows per second, which is conservative), plus the INA226 stream.
Everything runs at 1 Hz for 15 h a day, with 500 events a day. The test runs
12 simulated days. Each day inserts the raw rows, advances the injected clock,
then runs compaction, summary and event pruning to completion and a plain
`VACUUM`. That gives five insert/delete churn cycles once the 7-day window is
full. Minute and five-minute summaries fill out the rest of the 30 days.

| Table | Rows | Table | Indexes | Total |
| --- | ---: | ---: | ---: | ---: |
| `TelemetryReadings` (7 days raw) | 3,776,687 | 387.2 MB | 250.9 MB | 638.1 MB |
| `InaReadings` (7 days raw) | 378,000 | 39.2 MB | 20.9 MB | 60.1 MB |
| `TelemetryMinuteRollups` (23 days) | 207,000 | 35.9 MB | 9.7 MB | 45.7 MB |
| `TelemetryReadingRollups` (23 days) | 41,400 | 5.8 MB | 2.0 MB | 7.8 MB |
| `InaMinuteRollups` (23 days) | 20,700 | 4.1 MB | 0.6 MB | 4.7 MB |
| `PowerEvents` (30 days) | 6,000 | 2.2 MB | 0.3 MB | 2.5 MB |

Steady state after maintenance is **759.2 MB** for the whole schema, against
the 800 MB budget. The peak just before a day's compaction is 758.8 MB.
Growth flattens once the window is full: 752–759 MB from day 9 onward, because
`VACUUM` space is reused. Raw outlet rows cost 177 bytes each, indexes
included. The 7-day query over 3.78 M samples took 817 ms, measured while the
integration suite was running against the same server.

Headroom is about 41 MB (5%). Raw outlet rows are 84% of the total, so adding
channels or raising the sample rate does not fit without revisiting the budget.
The test fails if the footprint exceeds 800 MB.

## Tests

All of these run against local throwaway PostgreSQL only
(`MOR_TEST_DB_CONNECTION` on loopback, isolated `mor_ct_*` schema):

- `RetentionV2Tests`: flag matrix and startup rejection; flag off leaves
  legacy unchanged; seven-day boundary and whole-minute cutoff; exact minute,
  five-minute and INA226 summaries; split batches and late rows; rollback before
  commit; lost commit response; locked stream skipped; concurrent runners; budget
  and deadline deferral; 30-day summary and event pruning with the newest-20
  floor and untouched operational state; every history window unchanged by
  compaction; legacy cutover and rollback with no double counting.
- `RetentionMigrationTests`: upgrade from
  `20261019220000_BufferedTelemetryPersistence` keeps rows and indexes; the
  foreign keys restrict deletes; no destructive Up operations; the model
  snapshot is current.
- `SeederHistoryGuardTests`: the current seed re-runs over history for every
  outlet; identity changes and stale outlets with history stop startup; an
  identity change without history still relabels.
- `RetentionCapacityTests` (explicit): the capacity measurement above.
