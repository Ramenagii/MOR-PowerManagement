using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;

namespace Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;

public record UpdateThresholdsCommand : IRequest<int>
{
    public double? MaxCapacityWatts { get; init; }

    public double? WarningThresholdWatts { get; init; }

    // P_limit driving POL-02..POL-07.
    public double? CriticalThresholdWatts { get; init; }

    public double? StandbyThresholdWatts { get; init; }

    public int? StandbyIdleMinutes { get; init; }

    public int? StabilizationDelayMs { get; init; }
}

public class UpdateThresholdsCommandValidator : AbstractValidator<UpdateThresholdsCommand>
{
    public UpdateThresholdsCommandValidator()
    {
        RuleFor(x => x.MaxCapacityWatts).GreaterThan(0).When(x => x.MaxCapacityWatts.HasValue);
        RuleFor(x => x.WarningThresholdWatts).GreaterThan(0).When(x => x.WarningThresholdWatts.HasValue);
        RuleFor(x => x.CriticalThresholdWatts).GreaterThan(0).When(x => x.CriticalThresholdWatts.HasValue);
        RuleFor(x => x.StandbyThresholdWatts).GreaterThanOrEqualTo(0).When(x => x.StandbyThresholdWatts.HasValue);
        RuleFor(x => x.StandbyIdleMinutes).GreaterThanOrEqualTo(0).When(x => x.StandbyIdleMinutes.HasValue);
        RuleFor(x => x.StabilizationDelayMs).GreaterThanOrEqualTo(0).When(x => x.StabilizationDelayMs.HasValue);

        RuleFor(x => x).Custom((command, context) =>
        {
            if (command.WarningThresholdWatts.HasValue
                && command.CriticalThresholdWatts.HasValue
                && command.WarningThresholdWatts.Value >= command.CriticalThresholdWatts.Value)
            {
                context.AddFailure("Warning threshold must stay below the critical threshold (P_limit).");
            }
        });
    }
}

public class UpdateThresholdsCommandHandler : IRequestHandler<UpdateThresholdsCommand, int>
{
    private readonly IApplicationDbContext _context;

    public UpdateThresholdsCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<int> Handle(UpdateThresholdsCommand request, CancellationToken cancellationToken)
    {
        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken);

        if (config is null)
        {
            config = new PowerSystemConfig();
            _context.PowerSystemConfigs.Add(config);
        }

        if (request.MaxCapacityWatts.HasValue)
        {
            config.MaxCapacityWatts = request.MaxCapacityWatts.Value;
        }

        if (request.WarningThresholdWatts.HasValue)
        {
            config.WarningThresholdWatts = request.WarningThresholdWatts.Value;
        }

        if (request.CriticalThresholdWatts.HasValue)
        {
            config.CriticalThresholdWatts = request.CriticalThresholdWatts.Value;
        }

        if (request.StandbyThresholdWatts.HasValue)
        {
            config.StandbyThresholdWatts = request.StandbyThresholdWatts.Value;
        }

        if (request.StandbyIdleMinutes.HasValue)
        {
            config.StandbyIdleMinutes = request.StandbyIdleMinutes.Value;
        }

        if (request.StabilizationDelayMs.HasValue)
        {
            config.StabilizationDelayMs = request.StabilizationDelayMs.Value;
        }

        await _context.SaveChangesAsync(cancellationToken);

        return config.Id;
    }
}
