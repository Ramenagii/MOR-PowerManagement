using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;

public record TelemetrySample
{
    public int OutletId { get; init; }

    public double Voltage { get; init; }

    public double CurrentAmps { get; init; }

    public double PowerWatts { get; init; }

    public double EnergyKwh { get; init; }
}

public record RelayStateReport
{
    public int OutletId { get; init; }

    public bool RelayClosed { get; init; }
}

public record IngestTelemetryCommand : IRequest<IngestTelemetryResult>
{
    public string? DeviceId { get; init; }

    // S_fault: sensor or communication health flag from the ESP32.
    public bool FaultFlag { get; init; }

    public List<TelemetrySample> Readings { get; init; } = new();

    public List<RelayStateReport> RelayStates { get; init; } = new();
}

public record IngestTelemetryResult(
    double TotalWatts,
    SystemState State,
    int ReadingsStored,
    IReadOnlyList<string> EventsRaised);

public class IngestTelemetryCommandValidator : AbstractValidator<IngestTelemetryCommand>
{
    public IngestTelemetryCommandValidator()
    {
        RuleFor(x => x.Readings).NotEmpty();

        RuleForEach(x => x.Readings).ChildRules(sample =>
        {
            sample.RuleFor(s => s.OutletId).GreaterThan(0);
            sample.RuleFor(s => s.Voltage).InclusiveBetween(0, 300);
            sample.RuleFor(s => s.CurrentAmps).InclusiveBetween(0, 100);
            sample.RuleFor(s => s.PowerWatts).InclusiveBetween(0, 5000);
            sample.RuleFor(s => s.EnergyKwh).GreaterThanOrEqualTo(0);
        });
    }
}

public class IngestTelemetryCommandHandler : IRequestHandler<IngestTelemetryCommand, IngestTelemetryResult>
{
    private readonly IApplicationDbContext _context;

    public IngestTelemetryCommandHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<IngestTelemetryResult> Handle(IngestTelemetryCommand request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var eventsRaised = new List<string>();

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);
        var byId = outlets.ToDictionary(o => o.Id);

        foreach (var sample in request.Readings)
        {
            Guard.Against.NotFound(sample.OutletId, byId.GetValueOrDefault(sample.OutletId));

            var outlet = byId[sample.OutletId];

            _context.TelemetryReadings.Add(new TelemetryReading
            {
                OutletId = outlet.Id,
                Timestamp = now,
                Voltage = sample.Voltage,
                CurrentAmps = sample.CurrentAmps,
                PowerWatts = sample.PowerWatts,
                EnergyKwh = sample.EnergyKwh,
            });

            outlet.CurrentWatts = sample.PowerWatts;
            outlet.LastSeen = now;
        }

        foreach (var report in request.RelayStates)
        {
            if (!byId.TryGetValue(report.OutletId, out var outlet))
            {
                continue;
            }

            // Backend restriction sticks until cleared by policy action.
            if (outlet.Status == OutletStatus.Restricted)
            {
                continue;
            }

            outlet.Status = report.RelayClosed
                ? (outlet.CurrentWatts <= config.StandbyThresholdWatts ? OutletStatus.Standby : OutletStatus.Active)
                : OutletStatus.Disconnected;
        }

        if (request.FaultFlag && outlets.Any(o => o.Status != OutletStatus.Restricted))
        {
            // POL-01 hardware fault isolation: mirror the ESP32 lockout on the backend.
            foreach (var outlet in outlets)
            {
                outlet.Status = OutletStatus.Restricted;
            }

            AddEvent("Hardware fault isolation", "S_fault is TRUE: all relays restricted and the prototype isolated (POL-01).", EventSeverity.Critical, now, eventsRaised);
        }

        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts))
            .ToList();

        var total = LoadResponseEvaluator.TotalLoad(snapshots);
        var state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);

        if (state is SystemState.Warning or SystemState.Critical)
        {
            var title = $"System state: {state}";
            var latest = await _context.PowerEvents
                .OrderByDescending(e => e.Timestamp)
                .FirstOrDefaultAsync(cancellationToken);

            if (latest is null || latest.Title != title || latest.Timestamp < now.AddMinutes(-5))
            {
                AddEvent(
                    title,
                    $"P_total {total:F0} W crossed the configured threshold.",
                    state == SystemState.Critical ? EventSeverity.Critical : EventSeverity.Warning,
                    now,
                    eventsRaised);
            }
        }

        await _context.SaveChangesAsync(cancellationToken);

        return new IngestTelemetryResult(total, state, request.Readings.Count, eventsRaised);
    }

    private void AddEvent(string title, string detail, EventSeverity severity, DateTimeOffset now, List<string> raised)
    {
        _context.PowerEvents.Add(new PowerEvent
        {
            Timestamp = now,
            Title = title,
            Detail = detail,
            Severity = severity,
        });

        raised.Add(title);
    }
}
