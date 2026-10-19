using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;

// Backend twin of the dashboard pre-activation assessment (POL-02 / POL-03).
public record RequestOutletActivationCommand : IRequest<OutletActivationResult>
{
    public int OutletId { get; init; }
}

public record OutletActivationResult(
    int OutletId,
    bool Allowed,
    string PolicyCode,
    string Reason,
    OutletStatus Status,
    // Tier the activation was judged against, and whether this outlet is the
    // one exempt from its per-outlet cap.
    LoadTier Tier,
    bool PerOutletCapExempt);

public class RequestOutletActivationCommandHandler : IRequestHandler<RequestOutletActivationCommand, OutletActivationResult>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;

    private readonly PowerMutationCoordinator _mutations;

    public RequestOutletActivationCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
        : this(context, timeProvider, PowerMutationCoordinator.Legacy(new LoadSheddingStateStore()))
    {
    }

    public RequestOutletActivationCommandHandler(IApplicationDbContext context, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<OutletActivationResult> Handle(RequestOutletActivationCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<OutletActivationResult> Handle(RequestOutletActivationCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets
            .FirstOrDefaultAsync(o => o.Id == request.OutletId, cancellationToken);

        Guard.Against.NotFound(request.OutletId, outlet);

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);

        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name))
            .ToList();

        var total = LoadResponseEvaluator.TotalLoad(snapshots);

        // Per-outlet allowance cap (FR-04 / FR-05). Every tier is checked
        // against its own allowance; priority only changes shed ordering.
        var capExempt = LoadTierMapper.SelectCapExemptOutletIds(snapshots);
        var allowance = LoadSheddingEngine.AssessOutletAllowance(
            new OutletLoadSnapshot(outlet.Id, outlet.Priority, outlet.Status, outlet.CurrentWatts, outlet.AllowanceWatts, outlet.LastSeen, outlet.Name),
            outlet.CurrentWatts,
            capExempt);

        // Whole-system limit is checked separately from the branch allowance.
        var systemLimit = LoadResponseEvaluator.AssessActivation(
            total, outlet.AllowanceWatts, config.CriticalThresholdWatts, outlet.Name);

        var assessment = allowance.Verdict == ActivationVerdict.Blocked
            ? allowance
            : systemLimit;

        var now = _timeProvider.GetUtcNow();

        // F3 switch debounce: do not replace an in-flight command. The device
        // must acknowledge the current relay state and send its settled sample
        // before another manual switch request can be issued.
        if (outlet.PendingCommandId.HasValue)
        {
            return new OutletActivationResult(
                outlet.Id, false, "COMMAND_PENDING",
                "A relay command is still being confirmed. Wait for the relay state to settle before switching again.",
                outlet.Status, LoadTierMapper.ToTier(outlet.Priority), capExempt.Contains(outlet.Id));
        }

        if (outlet.FaultHold || outlet.RecoveryLockout || outlet.CommandNeedsReview)
        {
            var holdReason = outlet.FaultHold ? "fault hold" : outlet.RecoveryLockout ? "recovery lockout" : "unresolved relay response";
            var blocked = new PowerEvent { Timestamp = now, Title = "Manual restoration blocked", Detail = $"{outlet.Name} remains OFF because of {holdReason}; Admin clearance and response review are required.", Severity = EventSeverity.Critical };
            _context.PowerEvents.Add(blocked);
            await _context.SaveChangesAsync(cancellationToken);
            mutation.StageOutlets(outlets);
            mutation.StageEvent(blocked);
            mutation.MarkCommitted();
            return new OutletActivationResult(outlet.Id, false, "HOLD", $"Cannot restore while {holdReason} is active.", outlet.Status, LoadTierMapper.ToTier(outlet.Priority), capExempt.Contains(outlet.Id));
        }

        PowerEvent decided;
        if (assessment.Verdict == ActivationVerdict.Allowed)
        {
            outlet.Status = OutletStatus.Active;
            // Preserve the measured value until a fresh CT report arrives.
            outlet.ManualHold = false;
            outlet.NextRecoveryAtUtc = null;
            outlet.CommandedAtUtc = now;
            outlet.PendingCommandId = Guid.NewGuid();
            outlet.PendingRelayClosed = true;
            outlet.PendingCommandOrigin = "manual-on";
            outlet.PendingCommandIssuedAtUtc = now;
            outlet.PendingCommandAcknowledgedAtUtc = null;

            decided = new PowerEvent
            {
                Timestamp = now,
                Title = "Outlet activation allowed",
                Detail = $"{assessment.Reason} {outlet.Name} relay energized.",
                Severity = EventSeverity.Success,
            };
        }
        else
        {
            outlet.Status = OutletStatus.Restricted;

            decided = new PowerEvent
            {
                Timestamp = now,
                Title = "Activation blocked",
                Detail = assessment.Reason,
                Severity = EventSeverity.Warning,
            };
        }

        _context.PowerEvents.Add(decided);

        await _context.SaveChangesAsync(cancellationToken);

        mutation.StageOutlets(outlets);
        mutation.StageEvent(decided);
        mutation.MarkCommitted();

        return new OutletActivationResult(
            outlet.Id,
            assessment.Verdict == ActivationVerdict.Allowed,
            assessment.PolicyCode,
            assessment.Reason,
            outlet.Status,
            LoadTierMapper.ToTier(outlet.Priority),
            capExempt.Contains(outlet.Id));
    }
}
