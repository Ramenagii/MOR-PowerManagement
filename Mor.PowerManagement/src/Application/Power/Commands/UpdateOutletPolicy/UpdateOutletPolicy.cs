using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;

public record UpdateOutletPolicyCommand : IRequest<int>
{
    public int OutletId { get; init; }

    public OutletPriority? Priority { get; init; }

    public double? AllowanceWatts { get; init; }

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

    public UpdateOutletPolicyCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<int> Handle(UpdateOutletPolicyCommand request, CancellationToken cancellationToken)
    {
        var outlet = await _context.Outlets
            .FirstOrDefaultAsync(o => o.Id == request.OutletId, cancellationToken);

        Guard.Against.NotFound(request.OutletId, outlet);

        if (request.Priority.HasValue)
        {
            outlet.Priority = request.Priority.Value;
        }

        if (request.AllowanceWatts.HasValue)
        {
            outlet.AllowanceWatts = request.AllowanceWatts.Value;
        }

        if (request.Schedule is not null)
        {
            outlet.Schedule = request.Schedule;
        }

        if (request.ClearIdleLimit)
        {
            outlet.IdleLimitMinutes = null;
        }
        else if (request.IdleLimitMinutes.HasValue)
        {
            outlet.IdleLimitMinutes = request.IdleLimitMinutes.Value;
        }

        await _context.SaveChangesAsync(cancellationToken);

        return outlet.Id;
    }
}
