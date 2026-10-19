using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;

public record UpdateOutletPolicyCommand : IRequest<int>
{
    public int OutletId { get; init; }

    public string? Name { get; init; }

    public OutletPriority? Priority { get; init; }

    public double? AllowanceWatts { get; init; }

    public bool? IsProtected { get; init; }

    public string? Schedule { get; init; }

    // Set to change the idle limit; ignored when null.
    public int? IdleLimitMinutes { get; init; }

    // Set to true to mark the outlet exempt from idle shutdown.
    public bool ClearIdleLimit { get; init; }
}

public class UpdateOutletPolicyCommandValidator : AbstractValidator<UpdateOutletPolicyCommand>
{
    public UpdateOutletPolicyCommandValidator()
    {
        RuleFor(x => x.OutletId).GreaterThan(0);

        RuleFor(x => x.Name)
            .Must(name => !string.IsNullOrWhiteSpace(name))
            .MaximumLength(80)
            .When(x => x.Name is not null);

        RuleFor(x => x.AllowanceWatts)
            .GreaterThanOrEqualTo(0)
            .When(x => x.AllowanceWatts.HasValue);

        RuleFor(x => x.Schedule)
            .MaximumLength(200)
            .When(x => x.Schedule is not null);

        RuleFor(x => x.IdleLimitMinutes)
            .GreaterThanOrEqualTo(0)
            .When(x => x.IdleLimitMinutes.HasValue);
    }
}

public class UpdateOutletPolicyCommandHandler : IRequestHandler<UpdateOutletPolicyCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;

    private readonly PowerMutationCoordinator _mutations;

    public UpdateOutletPolicyCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
        : this(context, timeProvider, PowerMutationCoordinator.Legacy(new LoadSheddingStateStore()))
    {
    }

    public UpdateOutletPolicyCommandHandler(IApplicationDbContext context, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<int> Handle(UpdateOutletPolicyCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<int> Handle(UpdateOutletPolicyCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets
            .FirstOrDefaultAsync(o => o.Id == request.OutletId, cancellationToken);

        Guard.Against.NotFound(request.OutletId, outlet);
        mutation.OverlayLiveState(_context, new[] { outlet });

        var changes = new List<string>();

        if (request.Name is not null && !string.Equals(outlet.Name, request.Name.Trim(), StringComparison.Ordinal))
        {
            changes.Add($"name: '{outlet.Name}' → '{request.Name.Trim()}'");
            outlet.Name = request.Name.Trim();
        }

        if (request.Priority.HasValue)
        {
            if (outlet.Priority != request.Priority.Value)
                changes.Add($"priority: {outlet.Priority} → {request.Priority.Value}");
            outlet.Priority = request.Priority.Value;
        }

        if (request.AllowanceWatts.HasValue)
        {
            if (Math.Abs(outlet.AllowanceWatts - request.AllowanceWatts.Value) > 0.001)
                changes.Add($"allowance: {outlet.AllowanceWatts:F0} W → {request.AllowanceWatts.Value:F0} W");
            outlet.AllowanceWatts = request.AllowanceWatts.Value;
        }

        if (request.IsProtected.HasValue)
        {
            if (outlet.IsProtected != request.IsProtected.Value)
                changes.Add($"protected: {outlet.IsProtected} → {request.IsProtected.Value}");
            outlet.IsProtected = request.IsProtected.Value;
        }

        if (request.Schedule is not null)
        {
            if (!string.Equals(outlet.Schedule, request.Schedule, StringComparison.Ordinal))
                changes.Add("schedule label updated");
            outlet.Schedule = request.Schedule;
        }

        if (request.ClearIdleLimit)
        {
            if (outlet.IdleLimitMinutes is not null)
                changes.Add($"idle limit: {outlet.IdleLimitMinutes} min → exempt");
            outlet.IdleLimitMinutes = null;
        }
        else if (request.IdleLimitMinutes.HasValue)
        {
            if (outlet.IdleLimitMinutes != request.IdleLimitMinutes.Value)
                changes.Add($"idle limit: {outlet.IdleLimitMinutes?.ToString() ?? "exempt"} → {request.IdleLimitMinutes.Value} min");
            outlet.IdleLimitMinutes = request.IdleLimitMinutes.Value;
        }

        PowerEvent? changed = null;
        if (changes.Count > 0)
        {
            changed = new PowerEvent
            {
                Timestamp = _timeProvider.GetUtcNow(),
                Title = "Outlet settings changed",
                Detail = $"{outlet.Name} (CH{outlet.Id}): {string.Join("; ", changes)}.",
                Severity = EventSeverity.Info,
            };
            _context.PowerEvents.Add(changed);
        }

        await _context.SaveChangesAsync(cancellationToken);

        mutation.StageOutlet(outlet);
        if (changed is not null) mutation.StageEvent(changed);
        mutation.MarkCommitted();

        return outlet.Id;
    }
}
