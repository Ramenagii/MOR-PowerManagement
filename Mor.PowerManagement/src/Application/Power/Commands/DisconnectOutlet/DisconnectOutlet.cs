using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;

// Manual relay opening from the dashboard (toggle-off path).
public record DisconnectOutletCommand : IRequest<int>
{
    public int OutletId { get; init; }
}

public class DisconnectOutletCommandHandler : IRequestHandler<DisconnectOutletCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;

    private readonly PowerMutationCoordinator _mutations;

    public DisconnectOutletCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
        : this(context, timeProvider, PowerMutationCoordinator.Legacy(new LoadSheddingStateStore()))
    {
    }

    public DisconnectOutletCommandHandler(IApplicationDbContext context, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<int> Handle(DisconnectOutletCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<int> Handle(DisconnectOutletCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets
            .FirstOrDefaultAsync(o => o.Id == request.OutletId, cancellationToken);

        Guard.Against.NotFound(request.OutletId, outlet);

        // Debounce repeat clicks while the device is still applying the
        // current command. Replacing its command ID here makes the ESP32's
        // acknowledgement refer to an obsolete ID and can pause all automatic
        // switching until an Admin clears the resulting review hold.
        if (outlet.PendingCommandId.HasValue || outlet.CommandNeedsReview)
        {
            return outlet.Id;
        }

        // OFF is idempotent. Do not mint a new command for an outlet that is
        // already open; repeated switch presses must not restart the handshake.
        if (outlet.Status is OutletStatus.Disconnected or OutletStatus.Restricted)
        {
            return outlet.Id;
        }

        outlet.Status = OutletStatus.Disconnected;
        // Preserve the last measurement until a new sample arrives; relay OFF
        // does not make the meter read zero synchronously.
        outlet.ManualHold = true;
        outlet.NextRecoveryAtUtc = null;
        outlet.RecoveryTrialPending = false;
        outlet.CommandedAtUtc = _timeProvider.GetUtcNow();
        outlet.PendingCommandId = Guid.NewGuid();
        outlet.PendingRelayClosed = false;
        outlet.PendingCommandOrigin = "manual-off";
        outlet.PendingCommandIssuedAtUtc = outlet.CommandedAtUtc;
        outlet.PendingCommandAcknowledgedAtUtc = null;

        var powerEvent = new PowerEvent
        {
            Timestamp = _timeProvider.GetUtcNow(),
            Title = "Manual relay action",
            Detail = $"{outlet.Name} was disconnected from the dashboard.",
            Severity = EventSeverity.Info,
        };
        _context.PowerEvents.Add(powerEvent);

        await _context.SaveChangesAsync(cancellationToken);

        mutation.StageOutlet(outlet);
        mutation.StageEvent(powerEvent);
        mutation.MarkCommitted();

        return outlet.Id;
    }
}
