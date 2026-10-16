using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.RunStagedRestoration;

/// <summary>
/// Runs one step of the staged-restoration ladder on demand.
///
/// The AUTOMATIC ladder runs on every telemetry batch; this command exists so
/// an operator can (a) inspect what the ladder would do next, (b) drive it
/// immediately when they know the load is gone, and (c) force a step while the
/// manual override is latched. All three go through the same engine decision,
/// so a manual step and an automatic step cannot diverge in their ordering.
/// </summary>
public record RunStagedRestorationCommand : IRequest<StagedRestorationResult>
{
    // When true, the recovery-period and inter-reconnect waits are ignored.
    // The operator is asserting the load is gone; the hysteresis limit itself
    // is STILL enforced, because that is the check that stops the rig flapping.
    public bool Force { get; init; }
}

public record StagedRestorationResult(
    string Action,
    int? RestoredOutletId,
    string? RestoredOutletName,
    string? Tier,
    string Detail,
    double PLimitWatts,
    double RecoveryLimitWatts,
    double TotalWatts,
    int RecoveryPeriodSeconds,
    int InterReconnectDelaySeconds,
    IReadOnlyList<int> RemainingShedOutletIds,
    bool ManualOverrideActive);

public class RunStagedRestorationCommandHandler
    : IRequestHandler<RunStagedRestorationCommand, StagedRestorationResult>
{
    private readonly IApplicationDbContext _context;
    private readonly LoadSheddingStateStore _framework;

    public RunStagedRestorationCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework)
    {
        _context = context;
        _framework = framework;
    }

    public async Task<StagedRestorationResult> Handle(RunStagedRestorationCommand request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);

        var pLimit = config.CriticalThresholdWatts;
        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name))
            .ToList();

        var total = LoadResponseEvaluator.TotalLoad(snapshots);
        var current = _framework.Current;

        // Force skips the two WAITS only. It never skips the recovery-limit
        // check: forcing a reconnect into the hysteresis band is precisely the
        // oscillation the band exists to prevent.
        var effective = request.Force
            ? current with
            {
                BelowRecoveryLimitSinceUtc = now.AddSeconds(-LoadSheddingSettings.RecoveryPeriodSeconds),
                LastReconnectUtc = null,
                ManualOverride = false,
            }
            : current;

        var decision = LoadSheddingEngine.Evaluate(snapshots, pLimit, effective, now);

        if (decision.Action != LoadSheddingAction.Restore || decision.OutletId is not { } restoreId)
        {
            return new StagedRestorationResult(
                decision.Action.ToString(),
                null,
                null,
                null,
                decision.Detail,
                pLimit,
                decision.RecoveryLimitWatts,
                total,
                LoadSheddingSettings.RecoveryPeriodSeconds,
                LoadSheddingSettings.InterReconnectDelaySeconds,
                current.ShedLedger.Select(r => r.OutletId).ToList(),
                current.ManualOverride);
        }

        var outlet = outlets.First(o => o.Id == restoreId);
        if (outlet.FaultHold || outlet.RecoveryLockout || outlet.CommandNeedsReview)
        {
            throw new InvalidOperationException($"{outlet.Name} has an active hold that requires Admin review.");
        }
        var tier = LoadTierMapper.ToTier(outlet.Priority);

        outlet.Status = OutletStatus.Active;
        outlet.CommandedAtUtc = now;
        outlet.ManualHold = false;
        outlet.PendingCommandId = Guid.NewGuid();
        outlet.PendingRelayClosed = true;
        outlet.PendingCommandOrigin = "manual-on";
        outlet.PendingCommandIssuedAtUtc = now;
        outlet.PendingCommandAcknowledgedAtUtc = null;

        // Only persist the state when a relay actually moved. A refused step
        // must not reset the recovery clock, or repeatedly polling this command
        // would make the ladder permanently wait.
        _framework.Update(_ => decision.NextState);

        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = now,
            Title = "Staged restoration (operator)",
            Detail = decision.Detail,
            Severity = EventSeverity.Info,
        });

        await _context.SaveChangesAsync(cancellationToken);

        var next = _framework.Current;

        return new StagedRestorationResult(
            decision.Action.ToString(),
            outlet.Id,
            outlet.Name,
            tier.ToString(),
            decision.Detail,
            pLimit,
            decision.RecoveryLimitWatts,
            total,
            LoadSheddingSettings.RecoveryPeriodSeconds,
            LoadSheddingSettings.InterReconnectDelaySeconds,
            next.ShedLedger.Select(r => r.OutletId).ToList(),
            next.ManualOverride);
    }
}
