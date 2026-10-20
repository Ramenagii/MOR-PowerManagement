using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Mor.PowerManagement.Infrastructure.Data;

/// <summary>
/// Moves raw samples older than <c>Telemetry:RawRetentionHours</c> (default 6)
/// into five-minute per-outlet rollups, then prunes old rollups after
/// <c>Telemetry:RollupRetentionDays</c> (default 30). INA226 history is pruned
/// at the raw retention cutoff because the UI only needs its current sample.
///
/// Honest limitation: this is a <see cref="BackgroundService"/> on a host that
/// sleeps when idle, so pruning is <em>opportunistic</em> — it runs whenever the
/// host is awake, not on a schedule. Do not claim guaranteed retention.
/// </summary>
public sealed class TelemetryRetentionService(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<TelemetryRetentionService> logger,
    TimeProvider clock) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(15);

    public const int BatchSize = 50_000;

    /// Hard ceiling on batches per tick, so one tick can never monopolise the pool.
    public const int MaxBatchesPerTick = 20;

    public int RawRetentionHours => Math.Clamp(configuration.GetValue("Telemetry:RawRetentionHours", 6), 6, 168);

    public int RollupRetentionDays => Math.Clamp(configuration.GetValue("Telemetry:RollupRetentionDays", 30), 1, 3650);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (configuration.GetValue<bool>("Telemetry:BatchPersistenceEnabled")) return;

        // First prune runs after the first interval tick, never at startup, so it
        // cannot compete with InitialiseDatabaseAsync for the database during a
        // cold start.
        using var timer = new PeriodicTimer(Interval);

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await PruneAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Host is shutting down.
        }
        catch (Exception ex)
        {
            // Defensive only: the loop body already swallows everything. Letting a
            // background service throw takes the whole host down on Render.
            logger.LogWarning(ex, "Telemetry retention loop stopped unexpectedly.");
        }
    }

    public async Task PruneAsync(CancellationToken cancellationToken)
    {
        try
        {
            var now = clock.GetUtcNow();
            var rawCutoff = now.AddHours(-RawRetentionHours);
            var rollupCutoff = now.AddDays(-RollupRetentionDays);
            var rollupBucketsWritten = 0;
            var batches = 0;

            using var scope = scopeFactory.CreateScope();
            var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

            while (batches < MaxBatchesPerTick)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Move and summarize one bounded batch atomically. If the host
                // stops between batches, every row is either still raw or already
                // represented in its rollup; there is no history gap.
                var rowsAffected = await context.Database.ExecuteSqlInterpolatedAsync(
                    $"""
                    WITH candidates AS (
                        SELECT "Id" FROM "TelemetryReadings"
                        WHERE "Timestamp" < {rawCutoff}
                        ORDER BY "Id"
                        LIMIT {BatchSize}
                    ), moved AS (
                        DELETE FROM "TelemetryReadings" t
                        USING candidates c
                        WHERE t."Id" = c."Id"
                        RETURNING t."OutletId", t."Timestamp", t."Voltage",
                                  t."CurrentAmps", t."PowerWatts", t."EnergyKwh"
                    ), grouped AS (
                        SELECT "OutletId",
                               date_bin(INTERVAL '5 minutes', "Timestamp", TIMESTAMPTZ '2001-01-01 00:00:00+00') AS "BucketStart",
                               COUNT(*)::bigint AS "SampleCount",
                               SUM("Voltage") AS "VoltageSum",
                               SUM("CurrentAmps") AS "CurrentAmpsSum",
                               SUM("PowerWatts") AS "PowerWattsSum",
                               MIN("Voltage") AS "MinVoltage",
                               MAX("Voltage") AS "MaxVoltage",
                               MAX("PowerWatts") AS "PeakPowerWatts",
                               (array_agg("EnergyKwh" ORDER BY "Timestamp" ASC))[1] AS "FirstEnergyKwh",
                               MIN("Timestamp") AS "FirstSampleAt",
                               (array_agg("EnergyKwh" ORDER BY "Timestamp" DESC))[1] AS "LastEnergyKwh",
                               MAX("Timestamp") AS "LatestSampleAt"
                        FROM moved
                        GROUP BY "OutletId", 2
                    )
                    INSERT INTO "TelemetryReadingRollups" (
                        "OutletId", "BucketStart", "SampleCount", "VoltageSum",
                        "CurrentAmpsSum", "PowerWattsSum", "MinVoltage", "MaxVoltage",
                        "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt",
                        "LastEnergyKwh", "LatestSampleAt")
                    SELECT "OutletId", "BucketStart", "SampleCount", "VoltageSum",
                           "CurrentAmpsSum", "PowerWattsSum", "MinVoltage", "MaxVoltage",
                           "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt",
                           "LastEnergyKwh", "LatestSampleAt"
                    FROM grouped
                    ON CONFLICT ("OutletId", "BucketStart") DO UPDATE SET
                        "SampleCount" = "TelemetryReadingRollups"."SampleCount" + EXCLUDED."SampleCount",
                        "VoltageSum" = "TelemetryReadingRollups"."VoltageSum" + EXCLUDED."VoltageSum",
                        "CurrentAmpsSum" = "TelemetryReadingRollups"."CurrentAmpsSum" + EXCLUDED."CurrentAmpsSum",
                        "PowerWattsSum" = "TelemetryReadingRollups"."PowerWattsSum" + EXCLUDED."PowerWattsSum",
                        "MinVoltage" = LEAST("TelemetryReadingRollups"."MinVoltage", EXCLUDED."MinVoltage"),
                        "MaxVoltage" = GREATEST("TelemetryReadingRollups"."MaxVoltage", EXCLUDED."MaxVoltage"),
                        "PeakPowerWatts" = GREATEST("TelemetryReadingRollups"."PeakPowerWatts", EXCLUDED."PeakPowerWatts"),
                        "FirstEnergyKwh" = CASE WHEN EXCLUDED."FirstSampleAt" < "TelemetryReadingRollups"."FirstSampleAt" THEN EXCLUDED."FirstEnergyKwh" ELSE "TelemetryReadingRollups"."FirstEnergyKwh" END,
                        "FirstSampleAt" = LEAST("TelemetryReadingRollups"."FirstSampleAt", EXCLUDED."FirstSampleAt"),
                        "LastEnergyKwh" = CASE WHEN EXCLUDED."LatestSampleAt" > "TelemetryReadingRollups"."LatestSampleAt" THEN EXCLUDED."LastEnergyKwh" ELSE "TelemetryReadingRollups"."LastEnergyKwh" END,
                        "LatestSampleAt" = GREATEST("TelemetryReadingRollups"."LatestSampleAt", EXCLUDED."LatestSampleAt")
                    """,
                    cancellationToken);

                rollupBucketsWritten += rowsAffected;
                batches++;

                if (rowsAffected == 0)
                {
                    break;
                }
            }

            // INA226 historical rows are not used by the time-series endpoint;
            // the dashboard reads the latest sample, so keep only the same short
            // raw window here.
            var inaDeleted = await context.Database.ExecuteSqlInterpolatedAsync(
                $"""
                DELETE FROM "InaReadings" t
                WHERE t."Id" IN (
                    SELECT "Id" FROM "InaReadings"
                    WHERE "Timestamp" < {rawCutoff}
                    ORDER BY "Id"
                    LIMIT {BatchSize})
                """,
                cancellationToken);

            var rollupsDeleted = await context.Database.ExecuteSqlInterpolatedAsync(
                $"""
                DELETE FROM "TelemetryReadingRollups"
                WHERE "BucketStart" < {rollupCutoff}
                """,
                cancellationToken);

            // Deleting readings orphans nothing: Outlet.LastSeen,
            // Outlet.CurrentWatts and PowerEvents are independent rows, and
            // InaReadings reference no outlet at all.
            if (rollupBucketsWritten > 0 || inaDeleted > 0 || rollupsDeleted > 0 || batches > 1)
            {
                logger.LogInformation(
                    "Telemetry retention: wrote {RollupBucketsWritten} five-minute bucket(s), deleted {InaDeleted} INA226 row(s) and {RollupsDeleted} expired rollup(s) ({RawRetentionHours} raw hour(s), {RollupRetentionDays} rollup day(s), {Batches} batch(es)).",
                    rollupBucketsWritten,
                    inaDeleted,
                    rollupsDeleted,
                    RawRetentionHours,
                    RollupRetentionDays,
                    batches);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Never throw. An unreachable DB must not stop subsequent ticks.
            logger.LogWarning(ex, "Telemetry retention prune failed; will retry on the next tick.");
        }
    }
}
