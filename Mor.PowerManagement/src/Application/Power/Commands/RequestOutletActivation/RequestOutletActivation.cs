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
    OutletStatus Status);

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

        var total = LoadResponseEvaluator.TotalLoad(outlets.Select(o =>
            new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts)));

        var assessment = LoadResponseEvaluator.AssessActivation(
            total, outlet.AllowanceWatts, config.CriticalThresholdWatts, outlet.Name);

        var now = DateTimeOffset.UtcNow;

        if (assessment.Verdict == ActivationVerdict.Allowed)
        {
            outlet.Status = OutletStatus.Active;
            outlet.CurrentWatts = Math.Max(90, Math.Round(outlet.AllowanceWatts * 0.72));
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
            outlet.Status);
    }
}
