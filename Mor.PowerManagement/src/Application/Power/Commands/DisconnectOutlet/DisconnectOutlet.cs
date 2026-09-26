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

        outlet.Status = OutletStatus.Disconnected;
        outlet.CurrentWatts = 0;
        outlet.CommandedAtUtc = DateTimeOffset.UtcNow;

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
