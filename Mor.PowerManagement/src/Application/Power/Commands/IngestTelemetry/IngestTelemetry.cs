using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Constants;
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

    // Provenance of the readings in this batch. Optional so older firmware that
    // omits it keeps working (U10) — absent simply leaves the stored mode alone.
    public MeteringMode? MeteringMode { get; init; }

    public List<TelemetrySample> Readings { get; init; } = new();

    public List<RelayStateReport> RelayStates { get; init; } = new();
}

public record IngestTelemetryResult(
    double TotalWatts,
    SystemState State,
    int ReadingsStored,
    IReadOnlyList<string> EventsRaised,
    // Framework outcome for this batch. Null when the framework did not run
    // (it is skipped outright while the device is in hardware fault isolation,
    // because POL-01 has already restricted every relay).
    LoadSheddingResult? Shedding = null);

/// <summary>
/// What the load-shedding framework decided for one telemetry batch, and why.
/// Surfaced so the operator can see the ladder working rather than watching
/// relays move for unexplained reasons.
/// </summary>
public record LoadSheddingResult(
    string Action,
    int? OutletId,
    string? OutletName,
    string? Tier,
    string Detail,
    double PLimitWatts,
    double RecoveryLimitWatts,
    int ConsecutiveOverLimitBatches,
    int OverLimitConfirmationBatches,
    int RecoveryPeriodSeconds,
    IReadOnlyList<int> ShedOutletIds,
    bool ManualOverride,
    bool FaultLatched);

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
    private readonly LoadSheddingStateStore _framework;

    public IngestTelemetryCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework)
    {
        _context = context;
        _framework = framework;
    }

    public async Task<IngestTelemetryResult> Handle(IngestTelemetryCommand request, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var eventsRaised = new List<string>();

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        // Provenance is device-sourced (D8): it is only ever written from the
        // device's own report, never assumed here.
        if (request.MeteringMode is { } meteringMode)
        {
            config.MeteringMode = meteringMode;
            config.MeteringModeUpdatedAt = now;
        }

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

            if (report.RelayClosed)
            {
                outlet.Status = outlet.IdleLimitMinutes is null || outlet.CurrentWatts > config.StandbyThresholdWatts
                    ? OutletStatus.Active
                    : OutletStatus.Standby;
                outlet.CommandedAtUtc = null; // device confirmed: command fulfilled
                continue;
            }

            // Relay reports open: only downgrade to Disconnected when the
            // device has had a chance to confirm. A freshly commanded outlet
            // (commanded <60s ago, device polls config every ~15s) keeps its
            // commanded state until the device weighs in.
            var confirmationPending = outlet.CommandedAtUtc.HasValue
                && outlet.CommandedAtUtc.Value >= now.AddSeconds(-60);
            if (!confirmationPending)
            {
                outlet.Status = OutletStatus.Disconnected;
                outlet.CommandedAtUtc = null;
            }
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
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name))
            .ToList();

        double total = LoadResponseEvaluator.TotalLoad(snapshots);
        var state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);

        // ---- Priority-based load shedding / staged restoration (the thesis
        // framework). One tick per telemetry batch: confirm, shed at most one
        // branch, or restore at most one branch.
        //
        // Skipped entirely while POL-01 hardware fault isolation has restricted
        // every relay: the framework's job is to relieve a measured overload,
        // and during a hardware fault the measured numbers are exactly what
        // cannot be trusted. Running it here would stack automatic relay
        // operations on top of a fault the operator already has to see.
        LoadSheddingResult? shedding = null;

        if (!request.FaultFlag)
        {
            shedding = RunFramework(outlets, config, now, eventsRaised);

            // The framework may have opened a relay, which changes P_total.
            // Re-derive it so the returned total and state describe the rig as
            // the framework just left it, not as it arrived.
            if (shedding is { Action: nameof(LoadSheddingAction.Shed) })
            {
                total = LoadResponseEvaluator.TotalLoad(snapshots);
                state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);
            }
        }

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

        return new IngestTelemetryResult(total, state, request.Readings.Count, eventsRaised, shedding);
    }

    /// <summary>
    /// One framework tick: evaluate, apply the single decided action to the
    /// outlets, record it, and return what happened.
    /// </summary>
    private LoadSheddingResult RunFramework(
        IList<Outlet> outlets,
        PowerSystemConfig config,
        DateTimeOffset now,
        List<string> eventsRaised)
    {
        // P_limit is the existing critical threshold - the whole-system
        // operating limit POL-02..POL-07 already run on. No new config column.
        var pLimit = config.CriticalThresholdWatts;

        var decision = LoadSheddingEngine.Evaluate(
            outlets.Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name)).ToList(),
            pLimit,
            _framework.Current,
            now);

        _framework.Update(_ => decision.NextState);

        switch (decision.Action)
        {
            case LoadSheddingAction.Shed when decision.OutletId is { } shedId:
            {
                var shed = outlets.First(o => o.Id == shedId);
                shed.Status = OutletStatus.Disconnected;
                shed.CurrentWatts = 0;
                shed.CommandedAtUtc = now;

                AddEvent(
                    "Priority-based load shed",
                    decision.Detail,
                    EventSeverity.Warning,
                    now,
                    eventsRaised);
                break;
            }

            case LoadSheddingAction.Restore when decision.OutletId is { } restoreId:
            {
                var restore = outlets.First(o => o.Id == restoreId);
                restore.Status = OutletStatus.Active;
                // Restoration puts real power back on the branch. Until the rig
                // reports it, CurrentWatts stays 0 so P_total is understated and
                // the next batch over-reads briefly - which errs toward shedding
                // again rather than toward declaring the rig healthy.
                restore.CurrentWatts = 0;
                restore.CommandedAtUtc = now;

                AddEvent(
                    "Staged restoration",
                    decision.Detail,
                    EventSeverity.Info,
                    now,
                    eventsRaised);
                break;
            }

            case LoadSheddingAction.Alarm:
                AddEvent(
                    "Load-shedding alarm",
                    decision.Detail,
                    EventSeverity.Critical,
                    now,
                    eventsRaised);
                break;

            case LoadSheddingAction.None:
            default:
                // No action is a normal outcome (confirmation pending, or a
                // recovery timer still running). Logging it every 5 s would
                // bury the events that matter.
                break;
        }

        var acted = outlets.FirstOrDefault(o => o.Id == decision.OutletId);

        return new LoadSheddingResult(
            decision.Action.ToString(),
            decision.OutletId,
            acted?.Name,
            decision.Tier?.ToString(),
            decision.Detail,
            pLimit,
            decision.RecoveryLimitWatts,
            decision.ConsecutiveOverLimitBatches,
            decision.OverLimitConfirmationBatches,
            LoadSheddingSettings.RecoveryPeriodSeconds,
            decision.NextState.ShedLedger.Select(r => r.OutletId).ToList(),
            decision.NextState.ManualOverride,
            decision.NextState.FaultLatched);
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
