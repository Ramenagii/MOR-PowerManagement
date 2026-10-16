using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;

// POL-05 load shedding level 1: disconnect the lowest-priority energized outlets first.
public record ApplySelectiveResponseCommand : IRequest<SelectiveResponseResult>
{
    // Default 1, not 2: a default of 2 would shed two channels in one call, so on
    // the five-channel bench rig it would drop a third of the rig and leave
    // less of the ladder to demonstrate than shedding one at a time.
    public int Count { get; init; } = 1;

    // Operator override of automatic prioritisation. When set, the framework
    // stops shedding and restoring on its own and only the operator decides.
    // Explicit on this command too, so an operator can force a manual shed even
    // while the override is latched - the override disables AUTOMATION, it does
    // not disable the operator.
    public bool ManualOverride { get; init; }
}

public record SelectiveResponseResult(
    IReadOnlyList<int> ShedOutletIds,
    double TotalWatts,
    SystemState State,
    // What the framework did, so the operator sees the ladder's reasoning.
    IReadOnlyList<ShedDecisionDto> Shed,
    double PLimitWatts,
    double RecoveryLimitWatts,
    bool AutomaticPrioritisationEnabled,
    // True when this command sheddable branches existed but the manual override
    // was latched: the request was honoured by hand, not by the ladder.
    bool ManualOverrideActive);

public record ShedDecisionDto(
    int OutletId,
    string Name,
    string Tier,
    OutletPriority Priority,
    double WattsAtShed);

public class ApplySelectiveResponseCommandValidator : AbstractValidator<ApplySelectiveResponseCommand>
{
    public ApplySelectiveResponseCommandValidator()
    {
        // Upper bound is the bench rig's channel count (5: 4x220V + 1xUSB 5V).
        // Raise back to 13 with the full rig, otherwise a shed request can name
        // outlets that exist only in the full-rig spec.
        // DONE: the 4+USB bump (1, 2) -> (1, 5) landed with the five-row
        // testing rig seed. Only the upper bound moves on that bump; the
        // default Count = 1 above is already safe for both the 2-channel and
        // 5-channel rig.
        RuleFor(x => x.Count).InclusiveBetween(1, 5);
    }
}

public class ApplySelectiveResponseCommandHandler : IRequestHandler<ApplySelectiveResponseCommand, SelectiveResponseResult>
{
    private readonly IApplicationDbContext _context;
    private readonly LoadSheddingStateStore _framework;

    public ApplySelectiveResponseCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework)
    {
        _context = context;
        _framework = framework;
    }

    public async Task<SelectiveResponseResult> Handle(ApplySelectiveResponseCommand request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);

        // A manual shed is recorded in the same ledger the staged-restoration
        // ladder reads, so a branch the operator dropped by hand is restored by
        // the framework too (highest tier first), rather than being invisible to
        // it. Without this the two paths disagree about what is "shed".
        if (request.ManualOverride)
        {
            _framework.Update(state => state with { ManualOverride = true });
        }

        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name, o.IsProtected, o.ManualHold, o.RecoveryLockout, o.AutomaticRecoveryAttempts))
            .ToList();

        // Selection now goes through the framework's tier ladder (most
        // expendable tier first, highest current within a tier) instead of the
        // legacy OrderBy(priority).ThenBy(watts) that shed the smallest load
        // first. Count is applied to the ladder, not to the request, so a manual
        // shed obeys the same ordering the automatic one would.
        // A switching cycle permits only one relay command in flight. Count is
        // retained for wire compatibility; this invocation chooses one output.
        var candidates = LoadSheddingEngine.SelectNextShed(snapshots, 1);

        var shed = new List<ShedDecisionDto>();

        foreach (var outlet in outlets.Where(o => candidates.Any(c => c.Id == o.Id)))
        {
            var tier = LoadTierMapper.ToTier(outlet.Priority);

            shed.Add(new ShedDecisionDto(outlet.Id, outlet.Name, tier.ToString(), outlet.Priority, outlet.CurrentWatts));

            outlet.Status = OutletStatus.Disconnected;
            outlet.ManualHold = true;
            outlet.NextRecoveryAtUtc = null;
            outlet.RecoveryTrialPending = false;
            outlet.CommandedAtUtc = now;
            outlet.PendingCommandId = Guid.NewGuid();
            outlet.PendingRelayClosed = false;
            outlet.PendingCommandOrigin = "manual-off";
            outlet.PendingCommandIssuedAtUtc = now;
            outlet.PendingCommandAcknowledgedAtUtc = null;

            _framework.Update(state => state with
            {
                ShedLedger = state.ShedLedger
                    .Append(new ShedRecord(outlet.Id, tier, candidates.First(c => c.Id == outlet.Id).Watts, now))
                    .ToList(),
            });
        }

        var total = LoadResponseEvaluator.TotalLoad(outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts)));

        var state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);

        if (shed.Count > 0)
        {
            _context.PowerEvents.Add(new PowerEvent
            {
                Timestamp = now,
                Title = "Selective load response applied",
                Detail = $"Low-priority outlets disconnected first ({string.Join(", ", shed.Select(s => $"Outlet {s.OutletId} ({s.Tier}, {s.WattsAtShed:F0} W)"))}) " +
                    "while high-priority outlets remained active when possible (POL-05).",
                Severity = EventSeverity.Critical,
            });
        }
        else
        {
            // Nothing was eligible. That is a real outcome on a 2-outlet rig
            // once both outlets are down, and silently returning an empty list
            // would read as success.
            _context.PowerEvents.Add(new PowerEvent
            {
                Timestamp = now,
                Title = "Selective load response had no candidates",
                Detail = $"No outlet was eligible to shed. Tier 1 outlets are never shed automatically (FR-09), " +
                    $"and every lower tier is already disconnected. P_total {total:F0} W against P_limit {config.CriticalThresholdWatts:F0} W; " +
                    "the rig is NOT assumed safe.",
                Severity = EventSeverity.Critical,
            });
        }

        await _context.SaveChangesAsync(cancellationToken);

        var framework = _framework.Current;

        return new SelectiveResponseResult(
            shed.Select(s => s.OutletId).ToList(),
            total,
            state,
            shed,
            config.CriticalThresholdWatts,
            LoadSheddingEngine.ComputeRecoveryLimit(config.CriticalThresholdWatts),
            !framework.ManualOverride,
            framework.ManualOverride);
    }
}
