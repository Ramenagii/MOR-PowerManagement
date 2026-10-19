using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;

namespace Mor.PowerManagement.Application.Power.Commands.ClearOutletRecoveryState;

public record ClearOutletRecoveryStateCommand(int OutletId) : IRequest<int>;

public class ClearOutletRecoveryStateCommandHandler : IRequestHandler<ClearOutletRecoveryStateCommand, int>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;
    public ClearOutletRecoveryStateCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
    {
        _context = context;
        _timeProvider = timeProvider;
    }

    public async Task<int> Handle(ClearOutletRecoveryStateCommand request, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets.FirstOrDefaultAsync(x => x.Id == request.OutletId, cancellationToken);
        Guard.Against.NotFound(request.OutletId, outlet);
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
        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = _timeProvider.GetUtcNow(),
            Title = "Recovery state cleared by Admin",
            Detail = $"{outlet.Name} recovery counter and lockout were cleared after review. Its separate manual/fault holds were preserved.",
            Severity = Mor.PowerManagement.Domain.Enums.EventSeverity.Info,
        });
        await _context.SaveChangesAsync(cancellationToken);
        return outlet.Id;
    }
}
