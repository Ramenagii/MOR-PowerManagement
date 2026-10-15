using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;

// POL-05 load shedding level 1: disconnect the lowest-priority energized outlets first.
public record ApplySelectiveResponseCommand : IRequest<SelectiveResponseResult>
{
    // Default 1, not 2: the bench rig has two outlets, so a default of 2 would
    // shed the entire rig in one call and leave nothing to recover from.
    public int Count { get; init; } = 1;
}

public record SelectiveResponseResult(
    IReadOnlyList<int> ShedOutletIds,
    double TotalWatts,
    SystemState State);

public class ApplySelectiveResponseCommandValidator : AbstractValidator<ApplySelectiveResponseCommand>
{
    public ApplySelectiveResponseCommandValidator()
    {
        // Upper bound is the bench rig's channel count (2). Raise back to 13 with
        // the full rig, otherwise a shed request can name outlets that exist
        // only in the full-rig spec.
        // FUTURE 4+USB: (1, 5)
        // Only the upper bound moves on that bump; the default Count = 1 above
        // is already safe for both the 2-channel and 5-channel rig.
        RuleFor(x => x.Count).InclusiveBetween(1, 2);
    }
}

public class ApplySelectiveResponseCommandHandler : IRequestHandler<ApplySelectiveResponseCommand, SelectiveResponseResult>
{
    private readonly IApplicationDbContext _context;

    public ApplySelectiveResponseCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<SelectiveResponseResult> Handle(ApplySelectiveResponseCommand request, CancellationToken cancellationToken)
    {
        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);

        var candidates = LoadResponseEvaluator.SelectSheddingCandidates(
            outlets.Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts)),
            request.Count);

        foreach (var outlet in outlets.Where(o => candidates.Contains(o.Id)))
        {
            outlet.Status = OutletStatus.Disconnected;
            outlet.CurrentWatts = 0;
        }

        var total = outlets.Sum(o => o.CurrentWatts);
        var state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);

        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = DateTimeOffset.UtcNow,
            Title = "Selective load response applied",
            Detail = $"Low-priority outlets disconnected first ({string.Join(", ", candidates.Select(id => $"Outlet {id}"))}) while high-priority outlets remained active when possible (POL-05).",
            Severity = EventSeverity.Critical,
        });

        await _context.SaveChangesAsync(cancellationToken);

        return new SelectiveResponseResult(candidates, total, state);
    }
}
