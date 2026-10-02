using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Mor.PowerManagement.Infrastructure.Data;

/// <summary>
/// Bounds telemetry storage by deleting raw samples older than
/// <c>Telemetry:RetentionDays</c> (default 3). The rig posts 13 channels every
/// 5 s, which is 224,640 rows/day — roughly 34 MB/day and about 1 GB/month, so
/// unbounded growth is a genuine defect rather than a theoretical one.
///
/// Deliberately no hourly/daily rollup table in v1: one code path, one read path,
/// and a history measured in days does not justify doubling the read surface.
///
/// Honest limitation: this is a <see cref="BackgroundService"/> on a host that
/// sleeps when idle, so pruning is <em>opportunistic</em> — it runs whenever the
/// host is awake, not on a schedule. Do not claim guaranteed retention.
/// </summary>
public sealed class TelemetryRetentionService(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<TelemetryRetentionService> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(15);

    public const int BatchSize = 50_000;

    /// Hard ceiling on batches per tick, so one tick can never monopolise the pool.
    public const int MaxBatchesPerTick = 20;

    public int RetentionDays => configuration.GetValue("Telemetry:RetentionDays", 3);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
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

    private async Task PruneAsync(CancellationToken cancellationToken)
    {
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddDays(-RetentionDays);
            var deleted = 0;
            var batches = 0;

            using var scope = scopeFactory.CreateScope();
            var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

            while (batches < MaxBatchesPerTick)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Batched by primary key so a single DELETE never takes a long
                // row lock, and so an idle rig costs one no-op statement per tick.
                var rowsAffected = await context.Database.ExecuteSqlInterpolatedAsync(
                    $"""
                    DELETE FROM "TelemetryReadings" t
                    WHERE t."Id" IN (
                        SELECT "Id" FROM "TelemetryReadings"
                        WHERE "Timestamp" < {cutoff}
                        ORDER BY "Id"
                        LIMIT {BatchSize})
                    """,
                    cancellationToken);

                deleted += rowsAffected;
                batches++;

                if (rowsAffected < BatchSize)
                {
                    break;
                }
            }

            // Deleting readings orphans nothing: Outlet.LastSeen,
            // Outlet.CurrentWatts and PowerEvents are independent rows.
            if (deleted > 0 || batches > 1)
            {
                logger.LogInformation(
                    "Telemetry retention: deleted {Deleted} rows older than {Cutoff:o} ({RetentionDays} day(s), {Batches} batch(es)).",
                    deleted,
                    cutoff,
                    RetentionDays,
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
