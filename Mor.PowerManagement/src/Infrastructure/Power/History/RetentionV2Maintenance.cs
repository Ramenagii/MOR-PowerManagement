using Microsoft.Extensions.Logging;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Domain.Entities;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>
/// The V2 maintenance job, run by E's coordinator inside an already-open
/// durable window (startup initialization or a flush window). Order:
/// compact raw outlet rows, compact raw INA226 rows, prune 30-day summaries,
/// prune 30-day events. Work that does not fit before the window deadline is
/// deferred to the next window; each step is resumable on its own.
/// </summary>
public sealed class RetentionV2Maintenance(
    TelemetryCompactionRunner compaction,
    ControlEventRetention events,
    RetentionV2Options options,
    ILogger<RetentionV2Maintenance> logger) : IHistoryMaintenance
{
    private int legacyKeysReported;

    public string Name => "retention-v2";

    public async Task RunAsync(HistoryMaintenanceWindow window, CancellationToken cancellationToken)
    {
        if (options.IgnoredLegacyKeys.Count > 0 && Interlocked.Exchange(ref legacyKeysReported, 1) == 0)
        {
            logger.LogWarning("Retention V2 ignores legacy settings {Keys}; raw is kept 7 days and summaries 30 days.",
                string.Join(", ", options.IgnoredLegacyKeys));
        }

        var outlets = await compaction.CompactAsync(TelemetryCompactionCheckpoint.TelemetryStream, window.NowUtc, window.DeadlineUtc, cancellationToken);
        var ina = await compaction.CompactAsync(TelemetryCompactionCheckpoint.InaStream, window.NowUtc, window.DeadlineUtc, cancellationToken);
        var summaries = await compaction.PruneSummariesAsync(window.NowUtc, window.DeadlineUtc, cancellationToken);
        var (eventRows, eventsComplete) = await events.PruneAsync(window.NowUtc, window.DeadlineUtc, cancellationToken);

        logger.LogInformation(
            "Retention V2 ({Trigger}): compacted {OutletRows} outlet rows ({OutletState}) and {InaRows} INA226 rows ({InaState}); "
            + "pruned {MinuteRows} minute, {InaMinuteRows} INA226 minute, {FiveMinuteRows} five-minute buckets and {EventRows} events{Deferred}.",
            window.Trigger, outlets.Rows, outlets.State, ina.Rows, ina.State,
            summaries.MinuteRows, summaries.InaMinuteRows, summaries.FiveMinuteRows, eventRows,
            summaries.Complete && eventsComplete ? string.Empty : "; pruning deferred to the next window");
    }
}
