using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;

namespace Mor.PowerManagement.Application.Power.Commands.ClearOutletRecoveryState;

public record ClearOutletRecoveryStateCommand(int OutletId) : IRequest<int>;

public class ClearOutletRecoveryStateCommandHandler : IRequestHandler<ClearOutletRecoveryStateCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;

    private readonly PowerMutationCoordinator _mutations;

    public ClearOutletRecoveryStateCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
        : this(context, timeProvider, PowerMutationCoordinator.Legacy(new LoadSheddingStateStore()))
    {
    }

    public ClearOutletRecoveryStateCommandHandler(IApplicationDbContext context, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<int> Handle(ClearOutletRecoveryStateCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<int> Handle(ClearOutletRecoveryStateCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets.FirstOrDefaultAsync(x => x.Id == request.OutletId, cancellationToken);
        Guard.Against.NotFound(request.OutletId, outlet);
        mutation.OverlayLiveState(_context, new[] { outlet });
        outlet.AutomaticRecoveryAttempts = 0;
        outlet.RecoveryEpisodeId = Guid.NewGuid();
        outlet.RecoveryLockout = false;
        outlet.CommandNeedsReview = false;
        outlet.RecoveryTrialPending = false;
        outlet.RecoveryTrialOverLimitBatches = 0;
        outlet.NextRecoveryAtUtc = null;
        outlet.PendingCommandId = null;
        outlet.PendingRelayClosed = null;
        outlet.PendingCommandOrigin = null;
        outlet.PendingCommandIssuedAtUtc = null;
        outlet.PendingCommandAcknowledgedAtUtc = null;
        var powerEvent = new PowerEvent
        {
            Timestamp = _timeProvider.GetUtcNow(),
            Title = "Recovery state cleared by Admin",
            Detail = $"{outlet.Name} recovery counter and lockout were cleared after review. Its separate manual/fault holds were preserved.",
            Severity = Mor.PowerManagement.Domain.Enums.EventSeverity.Info,
        };
        _context.PowerEvents.Add(powerEvent);
        await _context.SaveChangesAsync(cancellationToken);
        mutation.StageOutlet(outlet);
        mutation.StageEvent(powerEvent);
        mutation.MarkCommitted();
        return outlet.Id;
    }
}
