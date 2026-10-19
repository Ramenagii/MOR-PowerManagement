namespace Mor.PowerManagement.Application.Power.History;

public enum HistoryMaintenanceTrigger
{
    /// <summary>Once after startup: bounded catch-up while the database is already awake.</summary>
    Initialization,

    /// <summary>Immediately after a successful batch flush, inside the same wake window.</summary>
    FlushWindow,
}

public sealed record HistoryMaintenanceWindow(HistoryMaintenanceTrigger Trigger, DateTimeOffset NowUtc, DateTimeOffset DeadlineUtc);

/// <summary>
/// Maintenance that runs only inside the batch-window coordinator's
/// opportunities (startup catch-up and flush windows), never on its own
/// timer, so an empty off-hours window runs nothing. Implementations use
/// short transactions, never take the runtime write gate, and stop at the
/// deadline, leaving the remaining work for the next opportunity.
/// Spec F replaces the registered implementation; the contract stays.
/// </summary>
public interface IHistoryMaintenance
{
    string Name { get; }

    Task RunAsync(HistoryMaintenanceWindow window, CancellationToken cancellationToken);
}
