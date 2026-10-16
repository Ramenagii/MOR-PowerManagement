using Mor.PowerManagement.Application.Common.Interfaces;
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

    public RequestOutletActivationCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<OutletActivationResult> Handle(RequestOutletActivationCommand request, CancellationToken cancellationToken)
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

        // Per-outlet allowance cap (FR-04 / FR-05, tier-aware). The tier-1
        // outlet is exempt from its OWN cap - not from P_limit, which is
        // checked separately below and still counts it.
        var capExempt = LoadTierMapper.SelectCapExemptOutletIds(snapshots);
        var allowance = LoadSheddingEngine.AssessOutletAllowance(
            new OutletLoadSnapshot(outlet.Id, outlet.Priority, outlet.Status, outlet.CurrentWatts, outlet.AllowanceWatts, outlet.LastSeen, outlet.Name),
            outlet.CurrentWatts,
            capExempt);

        // Whole-system limit. Checked even for the cap-exempt outlet: "no
        // per-outlet limit" must never read as "no limit at all".
        var systemLimit = LoadResponseEvaluator.AssessActivation(
            total, outlet.AllowanceWatts, config.CriticalThresholdWatts, outlet.Name);

        var assessment = allowance.Verdict == ActivationVerdict.Blocked
            ? allowance
            : systemLimit;

        var now = DateTimeOffset.UtcNow;

        if (assessment.Verdict == ActivationVerdict.Allowed)
        {
            outlet.Status = OutletStatus.Active;
            // Relay state is a control result, not a meter reading. Keep the
            // measured load at zero until the ESP32 posts a fresh CT sample;
            // an allowance-based estimate here showed 792 W / 3.33 A as if it
            // were measured current immediately after relay activation.
            outlet.CurrentWatts = 0;
            outlet.CommandedAtUtc = now;

            _context.PowerEvents.Add(new PowerEvent
            {
                Timestamp = now,
                Title = "Outlet activation allowed",
                Detail = $"{assessment.Reason} {outlet.Name} relay energized.",
                Severity = EventSeverity.Success,
            });
        }
        else
        {
            outlet.Status = OutletStatus.Restricted;

            _context.PowerEvents.Add(new PowerEvent
            {
                Timestamp = now,
                Title = "Activation blocked",
                Detail = assessment.Reason,
                Severity = EventSeverity.Warning,
            });
        }

        await _context.SaveChangesAsync(cancellationToken);

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
