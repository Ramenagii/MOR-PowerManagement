using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>
/// Seven-day raw compaction and 30-day summary pruning (PLAN-0001 Spec F).
///
/// One compaction batch is one short transaction over one raw stream:
/// lock the stream's checkpoint row (FOR UPDATE SKIP LOCKED, so a concurrent
/// runner skips instead of waiting), delete at most
/// <see cref="RetentionV2Options.CompactionBatchRows"/> raw rows older than the
/// cutoff, upsert their contribution into the minute tier (and, for outlet rows,
/// the five-minute tier the history query reads), and advance the checkpoint.
/// Delete, summaries and progress commit together or not at all, so a raw row
/// is either still raw or counted exactly once in its summaries.
///
/// The sweep has no lower bound: raw rows ARE the work queue. A late row with
/// an old timestamp is found by the next batch (Timestamp index / BRIN) and
/// merged into its existing bucket; every summary column merges (sums add,
/// extrema LEAST/GREATEST, first/last by sample time), so a minute split across
/// batches accumulates correctly.
/// </summary>
public sealed class TelemetryCompactionRunner(IServiceScopeFactory scopes, RetentionV2Options options, TimeProvider clock)
{
    // Same origin as the history query and the legacy rollups, so minute
    // buckets nest exactly inside five-minute buckets.
    public static readonly DateTimeOffset BinEpoch = new(2001, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static readonly TimeSpan Minute = TimeSpan.FromMinutes(1);

    private static readonly TimeSpan FiveMinutes = TimeSpan.FromMinutes(5);

    /// <summary>Raw rows strictly older than this are compacted: now - 7 days, floored to the minute (so raw is kept at least seven elapsed days).</summary>
    public static DateTimeOffset RawCutoff(DateTimeOffset now)
    {
        var cutoff = now - RetentionV2Options.RawRetention;
        return new DateTimeOffset(cutoff.UtcTicks - (cutoff.UtcTicks % TimeSpan.TicksPerMinute), TimeSpan.Zero);
    }

    /// <summary>Summary buckets starting before this are pruned: kept through day 30.</summary>
    public static DateTimeOffset SummaryCutoff(DateTimeOffset now) => now - RetentionV2Options.SummaryRetention;

    /// <summary>Compacts one stream until its backlog is empty, the batch budget is spent, or the deadline passes.</summary>
    public async Task<CompactionOutcome> CompactAsync(string stream, DateTimeOffset now, DateTimeOffset deadlineUtc, CancellationToken cancellationToken)
    {
        var cutoff = RawCutoff(now);
        long rows = 0;
        var batches = 0;
        while (batches < options.MaxBatchesPerRun)
        {
            if (clock.GetUtcNow() >= deadlineUtc) return new(rows, batches, CompactionState.Deferred);
            cancellationToken.ThrowIfCancellationRequested();
            var moved = await CompactBatchAsync(stream, cutoff, cancellationToken);
            if (moved is null) return new(rows, batches, CompactionState.Busy);
            rows += moved.Value;
            if (moved.Value == 0) return new(rows, batches, CompactionState.Complete);
            batches++;
            if (moved.Value < options.CompactionBatchRows) return new(rows, batches, CompactionState.Complete);
        }

        return new(rows, batches, CompactionState.Deferred);
    }

    /// <summary>
    /// One atomic batch. Returns the raw rows consumed, or null when another
    /// runner holds the stream (nothing was changed).
    /// </summary>
    public async Task<int?> CompactBatchAsync(string stream, DateTimeOffset cutoff, CancellationToken cancellationToken)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryCompactionCheckpoints" ("Stream", "CompactedRows", "CompactedBatches", "LastBatchRows")
            VALUES ({stream}, 0, 0, 0) ON CONFLICT DO NOTHING
            """, cancellationToken);
        var locked = await db.Database.SqlQuery<string>($"""
            SELECT "Stream" AS "Value" FROM "TelemetryCompactionCheckpoints"
            WHERE "Stream" = {stream} FOR UPDATE SKIP LOCKED
            """).ToListAsync(cancellationToken);
        if (locked.Count == 0)
        {
            await transaction.RollbackAsync(cancellationToken);
            return null;
        }

        var batch = stream switch
        {
            TelemetryCompactionCheckpoint.TelemetryStream => await CompactOutletRowsAsync(db, cutoff, cancellationToken),
            TelemetryCompactionCheckpoint.InaStream => await CompactInaRowsAsync(db, cutoff, cancellationToken),
            _ => throw new ArgumentOutOfRangeException(nameof(stream), stream, "Unknown compaction stream."),
        };

        if (batch.Moved > 0)
        {
            var at = clock.GetUtcNow();
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE "TelemetryCompactionCheckpoints" SET
                    "MinuteCoverageFromUtc" = COALESCE("MinuteCoverageFromUtc", {batch.OldestMoved}),
                    "LastCutoffUtc" = {cutoff},
                    "LastCompactedAtUtc" = {at},
                    "CompactedRows" = "CompactedRows" + {batch.Moved},
                    "CompactedBatches" = "CompactedBatches" + 1,
                    "LastBatchRows" = {batch.Moved}
                WHERE "Stream" = {stream}
                """, cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return batch.Moved;
    }

    private async Task<BatchCounts> CompactOutletRowsAsync(ApplicationDbContext db, DateTimeOffset cutoff, CancellationToken cancellationToken)
    {
        // First/last energy use a total order (time, then acquisition identity,
        // then row id) so equal timestamps resolve the same way on every run.
        var counts = await db.Database.SqlQuery<BatchCounts>($"""
            WITH candidates AS (
                SELECT "Id" FROM "TelemetryReadings"
                WHERE "Timestamp" < {cutoff}
                ORDER BY "Id"
                LIMIT {options.CompactionBatchRows}
            ), moved AS (
                DELETE FROM "TelemetryReadings" t
                USING candidates c
                WHERE t."Id" = c."Id"
                RETURNING t."Id", t."OutletId", t."Timestamp", t."Voltage", t."CurrentAmps",
                          t."PowerWatts", t."EnergyKwh", t."AcquisitionOrdinal", t."SampleOrdinal"
            ), minute AS (
                SELECT "OutletId",
                       date_bin({Minute}, "Timestamp", {BinEpoch}) AS "BucketStart",
                       COUNT(*)::bigint AS "SampleCount",
                       SUM("Voltage") AS "VoltageSum",
                       SUM("CurrentAmps") AS "CurrentAmpsSum",
                       SUM("PowerWatts") AS "PowerWattsSum",
                       MIN("Voltage") AS "MinVoltage",
                       MAX("Voltage") AS "MaxVoltage",
                       MIN("CurrentAmps") AS "MinCurrentAmps",
                       MAX("CurrentAmps") AS "MaxCurrentAmps",
                       MIN("PowerWatts") AS "MinPowerWatts",
                       MAX("PowerWatts") AS "MaxPowerWatts",
                       (array_agg("EnergyKwh" ORDER BY "Timestamp", "AcquisitionOrdinal" NULLS FIRST, "SampleOrdinal" NULLS FIRST, "Id"))[1] AS "FirstEnergyKwh",
                       MIN("Timestamp") AS "FirstSampleAt",
                       (array_agg("EnergyKwh" ORDER BY "Timestamp" DESC, "AcquisitionOrdinal" DESC NULLS LAST, "SampleOrdinal" DESC NULLS LAST, "Id" DESC))[1] AS "LastEnergyKwh",
                       MAX("EnergyKwh") AS "MaxEnergyKwh",
                       MAX("Timestamp") AS "LatestSampleAt"
                FROM moved
                GROUP BY 1, 2
            ), five AS (
                SELECT "OutletId",
                       date_bin({FiveMinutes}, "Timestamp", {BinEpoch}) AS "BucketStart",
                       COUNT(*)::bigint AS "SampleCount",
                       SUM("Voltage") AS "VoltageSum",
                       SUM("CurrentAmps") AS "CurrentAmpsSum",
                       SUM("PowerWatts") AS "PowerWattsSum",
                       MIN("Voltage") AS "MinVoltage",
                       MAX("Voltage") AS "MaxVoltage",
                       MAX("PowerWatts") AS "PeakPowerWatts",
                       (array_agg("EnergyKwh" ORDER BY "Timestamp", "AcquisitionOrdinal" NULLS FIRST, "SampleOrdinal" NULLS FIRST, "Id"))[1] AS "FirstEnergyKwh",
                       MIN("Timestamp") AS "FirstSampleAt",
                       (array_agg("EnergyKwh" ORDER BY "Timestamp" DESC, "AcquisitionOrdinal" DESC NULLS LAST, "SampleOrdinal" DESC NULLS LAST, "Id" DESC))[1] AS "LastEnergyKwh",
                       MAX("Timestamp") AS "LatestSampleAt"
                FROM moved
                GROUP BY 1, 2
            ), minute_upsert AS (
                INSERT INTO "TelemetryMinuteRollups" AS m (
                    "OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                    "MinVoltage", "MaxVoltage", "MinCurrentAmps", "MaxCurrentAmps", "MinPowerWatts", "MaxPowerWatts",
                    "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "MaxEnergyKwh", "LatestSampleAt")
                SELECT "OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                       "MinVoltage", "MaxVoltage", "MinCurrentAmps", "MaxCurrentAmps", "MinPowerWatts", "MaxPowerWatts",
                       "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "MaxEnergyKwh", "LatestSampleAt"
                FROM minute
                ON CONFLICT ("OutletId", "BucketStart") DO UPDATE SET
                    "SampleCount" = m."SampleCount" + EXCLUDED."SampleCount",
                    "VoltageSum" = m."VoltageSum" + EXCLUDED."VoltageSum",
                    "CurrentAmpsSum" = m."CurrentAmpsSum" + EXCLUDED."CurrentAmpsSum",
                    "PowerWattsSum" = m."PowerWattsSum" + EXCLUDED."PowerWattsSum",
                    "MinVoltage" = LEAST(m."MinVoltage", EXCLUDED."MinVoltage"),
                    "MaxVoltage" = GREATEST(m."MaxVoltage", EXCLUDED."MaxVoltage"),
                    "MinCurrentAmps" = LEAST(m."MinCurrentAmps", EXCLUDED."MinCurrentAmps"),
                    "MaxCurrentAmps" = GREATEST(m."MaxCurrentAmps", EXCLUDED."MaxCurrentAmps"),
                    "MinPowerWatts" = LEAST(m."MinPowerWatts", EXCLUDED."MinPowerWatts"),
                    "MaxPowerWatts" = GREATEST(m."MaxPowerWatts", EXCLUDED."MaxPowerWatts"),
                    "FirstEnergyKwh" = CASE WHEN EXCLUDED."FirstSampleAt" < m."FirstSampleAt" THEN EXCLUDED."FirstEnergyKwh" ELSE m."FirstEnergyKwh" END,
                    "FirstSampleAt" = LEAST(m."FirstSampleAt", EXCLUDED."FirstSampleAt"),
                    "LastEnergyKwh" = CASE WHEN EXCLUDED."LatestSampleAt" > m."LatestSampleAt" THEN EXCLUDED."LastEnergyKwh" ELSE m."LastEnergyKwh" END,
                    "MaxEnergyKwh" = GREATEST(m."MaxEnergyKwh", EXCLUDED."MaxEnergyKwh"),
                    "LatestSampleAt" = GREATEST(m."LatestSampleAt", EXCLUDED."LatestSampleAt")
                RETURNING 1
            ), five_upsert AS (
                INSERT INTO "TelemetryReadingRollups" AS f (
                    "OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                    "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt",
                    "LastEnergyKwh", "LatestSampleAt")
                SELECT "OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                       "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt",
                       "LastEnergyKwh", "LatestSampleAt"
                FROM five
                ON CONFLICT ("OutletId", "BucketStart") DO UPDATE SET
                    "SampleCount" = f."SampleCount" + EXCLUDED."SampleCount",
                    "VoltageSum" = f."VoltageSum" + EXCLUDED."VoltageSum",
                    "CurrentAmpsSum" = f."CurrentAmpsSum" + EXCLUDED."CurrentAmpsSum",
                    "PowerWattsSum" = f."PowerWattsSum" + EXCLUDED."PowerWattsSum",
                    "MinVoltage" = LEAST(f."MinVoltage", EXCLUDED."MinVoltage"),
                    "MaxVoltage" = GREATEST(f."MaxVoltage", EXCLUDED."MaxVoltage"),
                    "PeakPowerWatts" = GREATEST(f."PeakPowerWatts", EXCLUDED."PeakPowerWatts"),
                    "FirstEnergyKwh" = CASE WHEN EXCLUDED."FirstSampleAt" < f."FirstSampleAt" THEN EXCLUDED."FirstEnergyKwh" ELSE f."FirstEnergyKwh" END,
                    "FirstSampleAt" = LEAST(f."FirstSampleAt", EXCLUDED."FirstSampleAt"),
                    "LastEnergyKwh" = CASE WHEN EXCLUDED."LatestSampleAt" > f."LatestSampleAt" THEN EXCLUDED."LastEnergyKwh" ELSE f."LastEnergyKwh" END,
                    "LatestSampleAt" = GREATEST(f."LatestSampleAt", EXCLUDED."LatestSampleAt")
                RETURNING 1
            )
            SELECT (SELECT COUNT(*) FROM moved)::integer AS "Moved",
                   (SELECT MIN("Timestamp") FROM moved) AS "OldestMoved",
                   (SELECT COUNT(*) FROM minute_upsert)::integer AS "MinuteBuckets",
                   (SELECT COUNT(*) FROM five_upsert)::integer AS "FiveMinuteBuckets"
            """).ToListAsync(cancellationToken);
        return counts.Single();
    }

    private async Task<BatchCounts> CompactInaRowsAsync(ApplicationDbContext db, DateTimeOffset cutoff, CancellationToken cancellationToken)
    {
        // Each INA field keeps its own non-null count; SUM/MIN/MAX of an
        // all-NULL field stay NULL. A NULL merges as "no contribution".
        var counts = await db.Database.SqlQuery<BatchCounts>($"""
            WITH candidates AS (
                SELECT "Id" FROM "InaReadings"
                WHERE "Timestamp" < {cutoff}
                ORDER BY "Id"
                LIMIT {options.CompactionBatchRows}
            ), moved AS (
                DELETE FROM "InaReadings" t
                USING candidates c
                WHERE t."Id" = c."Id"
                RETURNING t."Timestamp", t."BusVoltageV", t."ShuntVoltageMv", t."CurrentA", t."PowerW"
            ), minute AS (
                SELECT date_bin({Minute}, "Timestamp", {BinEpoch}) AS "BucketStart",
                       COUNT(*)::bigint AS "SampleCount",
                       COUNT("BusVoltageV")::bigint AS "BusVoltageVCount",
                       SUM("BusVoltageV") AS "BusVoltageVSum",
                       MIN("BusVoltageV") AS "MinBusVoltageV",
                       MAX("BusVoltageV") AS "MaxBusVoltageV",
                       COUNT("ShuntVoltageMv")::bigint AS "ShuntVoltageMvCount",
                       SUM("ShuntVoltageMv") AS "ShuntVoltageMvSum",
                       MIN("ShuntVoltageMv") AS "MinShuntVoltageMv",
                       MAX("ShuntVoltageMv") AS "MaxShuntVoltageMv",
                       COUNT("CurrentA")::bigint AS "CurrentACount",
                       SUM("CurrentA") AS "CurrentASum",
                       MIN("CurrentA") AS "MinCurrentA",
                       MAX("CurrentA") AS "MaxCurrentA",
                       COUNT("PowerW")::bigint AS "PowerWCount",
                       SUM("PowerW") AS "PowerWSum",
                       MIN("PowerW") AS "MinPowerW",
                       MAX("PowerW") AS "MaxPowerW",
                       MIN("Timestamp") AS "FirstSampleAt",
                       MAX("Timestamp") AS "LatestSampleAt"
                FROM moved
                GROUP BY 1
            ), minute_upsert AS (
                INSERT INTO "InaMinuteRollups" AS m (
                    "BucketStart", "SampleCount",
                    "BusVoltageVCount", "BusVoltageVSum", "MinBusVoltageV", "MaxBusVoltageV",
                    "ShuntVoltageMvCount", "ShuntVoltageMvSum", "MinShuntVoltageMv", "MaxShuntVoltageMv",
                    "CurrentACount", "CurrentASum", "MinCurrentA", "MaxCurrentA",
                    "PowerWCount", "PowerWSum", "MinPowerW", "MaxPowerW",
                    "FirstSampleAt", "LatestSampleAt")
                SELECT "BucketStart", "SampleCount",
                       "BusVoltageVCount", "BusVoltageVSum", "MinBusVoltageV", "MaxBusVoltageV",
                       "ShuntVoltageMvCount", "ShuntVoltageMvSum", "MinShuntVoltageMv", "MaxShuntVoltageMv",
                       "CurrentACount", "CurrentASum", "MinCurrentA", "MaxCurrentA",
                       "PowerWCount", "PowerWSum", "MinPowerW", "MaxPowerW",
                       "FirstSampleAt", "LatestSampleAt"
                FROM minute
                ON CONFLICT ("BucketStart") DO UPDATE SET
                    "SampleCount" = m."SampleCount" + EXCLUDED."SampleCount",
                    "BusVoltageVCount" = m."BusVoltageVCount" + EXCLUDED."BusVoltageVCount",
                    "BusVoltageVSum" = CASE WHEN m."BusVoltageVSum" IS NULL THEN EXCLUDED."BusVoltageVSum" WHEN EXCLUDED."BusVoltageVSum" IS NULL THEN m."BusVoltageVSum" ELSE m."BusVoltageVSum" + EXCLUDED."BusVoltageVSum" END,
                    "MinBusVoltageV" = LEAST(m."MinBusVoltageV", EXCLUDED."MinBusVoltageV"),
                    "MaxBusVoltageV" = GREATEST(m."MaxBusVoltageV", EXCLUDED."MaxBusVoltageV"),
                    "ShuntVoltageMvCount" = m."ShuntVoltageMvCount" + EXCLUDED."ShuntVoltageMvCount",
                    "ShuntVoltageMvSum" = CASE WHEN m."ShuntVoltageMvSum" IS NULL THEN EXCLUDED."ShuntVoltageMvSum" WHEN EXCLUDED."ShuntVoltageMvSum" IS NULL THEN m."ShuntVoltageMvSum" ELSE m."ShuntVoltageMvSum" + EXCLUDED."ShuntVoltageMvSum" END,
                    "MinShuntVoltageMv" = LEAST(m."MinShuntVoltageMv", EXCLUDED."MinShuntVoltageMv"),
                    "MaxShuntVoltageMv" = GREATEST(m."MaxShuntVoltageMv", EXCLUDED."MaxShuntVoltageMv"),
                    "CurrentACount" = m."CurrentACount" + EXCLUDED."CurrentACount",
                    "CurrentASum" = CASE WHEN m."CurrentASum" IS NULL THEN EXCLUDED."CurrentASum" WHEN EXCLUDED."CurrentASum" IS NULL THEN m."CurrentASum" ELSE m."CurrentASum" + EXCLUDED."CurrentASum" END,
                    "MinCurrentA" = LEAST(m."MinCurrentA", EXCLUDED."MinCurrentA"),
                    "MaxCurrentA" = GREATEST(m."MaxCurrentA", EXCLUDED."MaxCurrentA"),
                    "PowerWCount" = m."PowerWCount" + EXCLUDED."PowerWCount",
                    "PowerWSum" = CASE WHEN m."PowerWSum" IS NULL THEN EXCLUDED."PowerWSum" WHEN EXCLUDED."PowerWSum" IS NULL THEN m."PowerWSum" ELSE m."PowerWSum" + EXCLUDED."PowerWSum" END,
                    "MinPowerW" = LEAST(m."MinPowerW", EXCLUDED."MinPowerW"),
                    "MaxPowerW" = GREATEST(m."MaxPowerW", EXCLUDED."MaxPowerW"),
                    "FirstSampleAt" = LEAST(m."FirstSampleAt", EXCLUDED."FirstSampleAt"),
                    "LatestSampleAt" = GREATEST(m."LatestSampleAt", EXCLUDED."LatestSampleAt")
                RETURNING 1
            )
            SELECT (SELECT COUNT(*) FROM moved)::integer AS "Moved",
                   (SELECT MIN("Timestamp") FROM moved) AS "OldestMoved",
                   (SELECT COUNT(*) FROM minute_upsert)::integer AS "MinuteBuckets",
                   0 AS "FiveMinuteBuckets"
            """).ToListAsync(cancellationToken);
        return counts.Single();
    }

    /// <summary>
    /// Deletes summary buckets that start before day 30, in bounded autocommit
    /// batches. Idempotent: a concurrent runner deleting the same buckets only
    /// finds fewer rows.
    /// </summary>
    public async Task<SummaryPruneOutcome> PruneSummariesAsync(DateTimeOffset now, DateTimeOffset deadlineUtc, CancellationToken cancellationToken)
    {
        var cutoff = SummaryCutoff(now);
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var limit = options.PruneBatchRows;
        var minute = await PruneLoopAsync(deadlineUtc, () => db.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM "TelemetryMinuteRollups" t
            USING (SELECT "OutletId", "BucketStart" FROM "TelemetryMinuteRollups"
                   WHERE "BucketStart" < {cutoff} ORDER BY "BucketStart" LIMIT {limit}) d
            WHERE t."OutletId" = d."OutletId" AND t."BucketStart" = d."BucketStart"
            """, cancellationToken), cancellationToken);
        var ina = await PruneLoopAsync(deadlineUtc, () => db.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM "InaMinuteRollups" t
            USING (SELECT "BucketStart" FROM "InaMinuteRollups"
                   WHERE "BucketStart" < {cutoff} ORDER BY "BucketStart" LIMIT {limit}) d
            WHERE t."BucketStart" = d."BucketStart"
            """, cancellationToken), cancellationToken);
        var five = await PruneLoopAsync(deadlineUtc, () => db.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM "TelemetryReadingRollups" t
            USING (SELECT "OutletId", "BucketStart" FROM "TelemetryReadingRollups"
                   WHERE "BucketStart" < {cutoff} ORDER BY "BucketStart" LIMIT {limit}) d
            WHERE t."OutletId" = d."OutletId" AND t."BucketStart" = d."BucketStart"
            """, cancellationToken), cancellationToken);
        return new(minute.Rows, ina.Rows, five.Rows, minute.Complete && ina.Complete && five.Complete);
    }

    internal async Task<(long Rows, bool Complete)> PruneLoopAsync(DateTimeOffset deadlineUtc, Func<Task<int>> deleteBatch, CancellationToken cancellationToken)
    {
        long rows = 0;
        for (var batches = 0; batches < options.MaxBatchesPerRun; batches++)
        {
            if (clock.GetUtcNow() >= deadlineUtc) return (rows, false);
            cancellationToken.ThrowIfCancellationRequested();
            var deleted = await deleteBatch();
            rows += deleted;
            if (deleted < options.PruneBatchRows) return (rows, true);
        }

        return (rows, false);
    }

    // Row shape of the compaction statement, read through SqlQuery<T>.
    public sealed record BatchCounts(int Moved, DateTimeOffset? OldestMoved, int MinuteBuckets, int FiveMinuteBuckets);
}

public enum CompactionState
{
    /// <summary>No raw row older than the cutoff remained when the run stopped.</summary>
    Complete,

    /// <summary>The batch budget or deadline ran out; the rest waits for the next maintenance window.</summary>
    Deferred,

    /// <summary>Another runner held the stream; this run changed nothing more.</summary>
    Busy,
}

public sealed record CompactionOutcome(long Rows, int Batches, CompactionState State);

public sealed record SummaryPruneOutcome(long MinuteRows, long InaMinuteRows, long FiveMinuteRows, bool Complete);
