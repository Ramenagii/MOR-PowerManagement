using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

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
    private readonly TimeProvider _timeProvider;

    public UpdateThresholdsCommandHandler(IApplicationDbContext context, TimeProvider timeProvider)
    {
        _context = context;
        _timeProvider = timeProvider;
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

        var changes = new List<string>();

        if (request.MaxCapacityWatts.HasValue)
        {
            if (Math.Abs(config.MaxCapacityWatts - request.MaxCapacityWatts.Value) > 0.001)
                changes.Add($"system capacity: {config.MaxCapacityWatts:F0} W → {request.MaxCapacityWatts.Value:F0} W");
            config.MaxCapacityWatts = request.MaxCapacityWatts.Value;
        }

        if (request.WarningThresholdWatts.HasValue)
        {
            if (Math.Abs(config.WarningThresholdWatts - request.WarningThresholdWatts.Value) > 0.001)
                changes.Add($"warning threshold: {config.WarningThresholdWatts:F0} W → {request.WarningThresholdWatts.Value:F0} W");
            config.WarningThresholdWatts = request.WarningThresholdWatts.Value;
        }

        if (request.CriticalThresholdWatts.HasValue)
        {
            if (Math.Abs(config.CriticalThresholdWatts - request.CriticalThresholdWatts.Value) > 0.001)
                changes.Add($"critical threshold: {config.CriticalThresholdWatts:F0} W → {request.CriticalThresholdWatts.Value:F0} W");
            config.CriticalThresholdWatts = request.CriticalThresholdWatts.Value;
        }

        if (request.StandbyThresholdWatts.HasValue)
        {
            if (Math.Abs(config.StandbyThresholdWatts - request.StandbyThresholdWatts.Value) > 0.001)
                changes.Add($"standby cutoff: {config.StandbyThresholdWatts:F0} W → {request.StandbyThresholdWatts.Value:F0} W");
            config.StandbyThresholdWatts = request.StandbyThresholdWatts.Value;
        }

        if (request.StandbyIdleMinutes.HasValue)
        {
            if (config.StandbyIdleMinutes != request.StandbyIdleMinutes.Value)
                changes.Add($"standby timeout: {config.StandbyIdleMinutes} → {request.StandbyIdleMinutes.Value} min");
            config.StandbyIdleMinutes = request.StandbyIdleMinutes.Value;
        }

        if (request.StabilizationDelayMs.HasValue)
        {
            if (config.StabilizationDelayMs != request.StabilizationDelayMs.Value)
                changes.Add($"stabilization delay: {config.StabilizationDelayMs} → {request.StabilizationDelayMs.Value} ms");
            config.StabilizationDelayMs = request.StabilizationDelayMs.Value;
        }

        if (changes.Count > 0)
        {
            _context.PowerEvents.Add(new PowerEvent
            {
                Timestamp = _timeProvider.GetUtcNow(),
                Title = "System thresholds changed",
                Detail = string.Join("; ", changes) + ".",
                Severity = EventSeverity.Info,
            });
        }

        await _context.SaveChangesAsync(cancellationToken);

        return config.Id;
    }
}
