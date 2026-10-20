using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Commands.AcknowledgeOutletFault;

public record AcknowledgeOutletFaultCommand(int OutletId) : IRequest<int>;

public class AcknowledgeOutletFaultCommandHandler : IRequestHandler<AcknowledgeOutletFaultCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;

    private readonly PowerMutationCoordinator _mutations;

    public AcknowledgeOutletFaultCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
        : this(context, timeProvider, PowerMutationCoordinator.Legacy(new LoadSheddingStateStore()))
    {
    }

    public AcknowledgeOutletFaultCommandHandler(IApplicationDbContext context, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<int> Handle(AcknowledgeOutletFaultCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<int> Handle(AcknowledgeOutletFaultCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets.FirstOrDefaultAsync(x => x.Id == request.OutletId, cancellationToken);
        Guard.Against.NotFound(request.OutletId, outlet);
        mutation.OverlayLiveState(_context, new[] { outlet });
        outlet.FaultHold = false;
        outlet.Status = OutletStatus.Disconnected;
        var powerEvent = new PowerEvent
        {
            Timestamp = _timeProvider.GetUtcNow(),
            Title = "Fault hold acknowledged",
            Detail = $"Admin acknowledged the hardware fault hold for {outlet.Name}. The outlet remains OFF until manually restored.",
            Severity = EventSeverity.Warning,
        };
        _context.PowerEvents.Add(powerEvent);
        await _context.SaveChangesAsync(cancellationToken);
        mutation.StageOutlet(outlet);
        mutation.StageEvent(powerEvent);
        mutation.MarkCommitted();
        return outlet.Id;
    }
}
