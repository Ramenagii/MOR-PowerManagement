using Mor.PowerManagement.Application.Common.Interfaces;
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

    public DisconnectOutletCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<int> Handle(DisconnectOutletCommand request, CancellationToken cancellationToken)
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
        outlet.CommandedAtUtc = DateTimeOffset.UtcNow;
        outlet.PendingCommandId = Guid.NewGuid();
        outlet.PendingRelayClosed = false;
        outlet.PendingCommandOrigin = "manual-off";
        outlet.PendingCommandIssuedAtUtc = outlet.CommandedAtUtc;
        outlet.PendingCommandAcknowledgedAtUtc = null;

        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = DateTimeOffset.UtcNow,
            Title = "Manual relay action",
            Detail = $"{outlet.Name} was disconnected from the dashboard.",
            Severity = EventSeverity.Info,
        });

        await _context.SaveChangesAsync(cancellationToken);

        return outlet.Id;
    }
}
