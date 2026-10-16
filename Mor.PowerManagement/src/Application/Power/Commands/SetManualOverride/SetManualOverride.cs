using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.SetManualOverride;

/// <summary>
/// Operator override of automatic prioritisation. While enabled the framework
/// still MEASURES and still RAISES ALARMS, but it opens and closes no relay on
/// its own.
/// </summary>
public record SetManualOverrideCommand : IRequest<ManualOverrideResult>
{
    public bool Enabled { get; init; }

    // Optional operator note, recorded on the audit event so an override that
    // outlives the shift can be explained later.
    public string? Reason { get; init; }
}

public record ManualOverrideResult(
    bool Enabled,
    string Detail,
    int ShedOutletCount,
    IReadOnlyList<int> ShedOutletIds);

public class SetManualOverrideCommandValidator : AbstractValidator<SetManualOverrideCommand>
{
    public SetManualOverrideCommandValidator()
    {
        RuleFor(x => x.Reason)
            .MaximumLength(400)
            .When(x => x.Reason is not null);
    }
}

public class SetManualOverrideCommandHandler : IRequestHandler<SetManualOverrideCommand, ManualOverrideResult>
{
    private readonly IApplicationDbContext _context;
    private readonly LoadSheddingStateStore _framework;

    public SetManualOverrideCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework)
    {
        _context = context;
        _framework = framework;
    }

    public async Task<ManualOverrideResult> Handle(SetManualOverrideCommand request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;

        var state = _framework.Update(s => s with { ManualOverride = request.Enabled });

        var detail = request.Enabled
            ? "Operator disabled automatic prioritisation. Load shedding and staged restoration are suspended; measurement and alarms continue."
            : "Operator re-enabled automatic prioritisation. Load shedding and staged restoration resume on the next telemetry batch.";

        if (request.Reason is { Length: > 0 } reason)
        {
            detail += $" Reason given: {reason}";
        }

        if (state.ShedLedger.Count > 0 && request.Enabled)
        {
            detail += $" Note: {state.ShedLedger.Count} branch(es) are still shed and will NOT be restored automatically until the override is cleared.";
        }

        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = now,
            Title = request.Enabled ? "Automatic prioritisation disabled" : "Automatic prioritisation enabled",
            Detail = detail,
            // Deliberately Warning, not Info: an override means the rig is no
            // longer protecting itself, and that must be visible in the event
            // log rather than buried in a settings screen.
            Severity = request.Enabled ? EventSeverity.Warning : EventSeverity.Success,
        });

        await _context.SaveChangesAsync(cancellationToken);

        return new ManualOverrideResult(
            request.Enabled,
            detail,
            state.ShedLedger.Count,
            state.ShedLedger.Select(r => r.OutletId).ToList());
    }
}