using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Commands.AcknowledgeOutletFault;

public record AcknowledgeOutletFaultCommand(int OutletId) : IRequest<int>;

public class AcknowledgeOutletFaultCommandHandler : IRequestHandler<AcknowledgeOutletFaultCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;
    public AcknowledgeOutletFaultCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
    {
        _context = context;
        _timeProvider = timeProvider;
    }

    public async Task<int> Handle(AcknowledgeOutletFaultCommand request, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets.FirstOrDefaultAsync(x => x.Id == request.OutletId, cancellationToken);
        Guard.Against.NotFound(request.OutletId, outlet);
        outlet.FaultHold = false;
        outlet.Status = OutletStatus.Disconnected;
        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = _timeProvider.GetUtcNow(),
            Title = "Fault hold acknowledged",
            Detail = $"Admin acknowledged the hardware fault hold for {outlet.Name}. The outlet remains OFF until manually restored.",
            Severity = EventSeverity.Warning,
        });
        await _context.SaveChangesAsync(cancellationToken);
        return outlet.Id;
    }
}
