using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;

// POL-05 load shedding level 1: disconnect the lowest-priority energized outlets first.
public record ApplySelectiveResponseCommand : IRequest<SelectiveResponseResult>
{
    public int Count { get; init; } = 2;
}

public record SelectiveResponseResult(
    IReadOnlyList<int> ShedOutletIds,
    double TotalWatts,
    SystemState State);

public class ApplySelectiveResponseCommandValidator : AbstractValidator<ApplySelectiveResponseCommand>
{
    public ApplySelectiveResponseCommandValidator()
    {
        RuleFor(x => x.Count).InclusiveBetween(1, 13);
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
