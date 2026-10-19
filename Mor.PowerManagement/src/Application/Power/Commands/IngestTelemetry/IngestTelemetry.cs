using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
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

    public Guid? CommandId { get; init; }
}

/// <summary>
/// The INA226's OWN readings for one batch, as the DC-side sensor measured them.
/// This is not a branch figure: it is the bus voltage, shunt drop, current and
/// power behind every derived branch reading in the same batch.
///
/// Nullable throughout, and independently so. Older firmware posts no
/// <c>ina</c> object at all, and a sensor that answered for some registers and
/// not others must not have the values it did report thrown away.
/// </summary>
public record Ina226Report
{
    // V at the INA226 bus pin (~24 V on this rig, not mains volts).
    public double? BusV { get; init; }

    // mV across the shunt resistor.
    public double? ShuntMv { get; init; }

    // A through the shunt.
    public double? CurrentA { get; init; }

    // W at the INA226 bus pin.
    public double? PowerW { get; init; }
}

public record IngestTelemetryCommand : IRequest<IngestTelemetryResult>
{
    public string? DeviceId { get; init; }

    public Guid? AcquisitionSessionId { get; init; }

    public long? AcquisitionSequence { get; init; }

    // S_fault: sensor or communication health flag from the ESP32.
    public bool FaultFlag { get; init; }

    // Provenance of the readings in this batch. Optional so older firmware that
    // omits it keeps working (U10) — absent simply leaves the stored mode alone.
    public MeteringMode? MeteringMode { get; init; }

    public List<TelemetrySample> Readings { get; init; } = new();

    public List<RelayStateReport> RelayStates { get; init; } = new();

    // Optional, for the same (U10) reason as MeteringMode: firmware predating
    // the `ina` block posts nothing here and simply keeps no INA226 history.
    public Ina226Report? Ina { get; init; }
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
    int OverLimitConfirmationSeconds,
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

        // INA226 sanity bands. These are the sensor's physical envelope on this
        // rig, not the branch ranges above: busV is the DC BUS pin (~24 V), not
        // mains volts, so the 0-300 branch band would let a 240 V "bus" reading
        // through; currentA is bounded by what a 10 mOhm shunt carries; powerW
        // is bounded by what the rail can deliver. A reading outside the band is
        // a broken sensor or a mis-scaled shunt, and storing it would put a
        // physically impossible number in front of the operator.
        //
        // Each is checked only when present - a partial `ina` from a sensor that
        // answered for some registers is valid data, not an error. ShuntMv is
        // deliberately unbounded: the shunt drop is signed (a reverse-biased or
        // current-reversing rig reports it negative), so any range here would
        // reject a real measurement.
        When(x => x.Ina is not null, () =>
        {
            RuleFor(x => x.Ina!.BusV).InclusiveBetween(0, 40);
            RuleFor(x => x.Ina!.CurrentA).InclusiveBetween(0, 10);
            RuleFor(x => x.Ina!.PowerW).InclusiveBetween(0, 500);
        });
    }
}

public class IngestTelemetryCommandHandler : IRequestHandler<IngestTelemetryCommand, IngestTelemetryResult>
{
    private readonly IApplicationDbContext _context;
    private readonly TimeProvider _timeProvider;
    private readonly PowerMutationCoordinator _mutations;

    public IngestTelemetryCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework, TimeProvider timeProvider)
        : this(context, framework, timeProvider, PowerMutationCoordinator.Legacy(framework))
    {
    }

    public IngestTelemetryCommandHandler(IApplicationDbContext context, LoadSheddingStateStore framework, TimeProvider timeProvider, PowerMutationCoordinator mutations)
    {
        _context = context;
        _timeProvider = timeProvider;
        _mutations = mutations;
    }

    public Task<IngestTelemetryResult> Handle(IngestTelemetryCommand request, CancellationToken cancellationToken)
        => _mutations.ExecuteAsync(mutation => Handle(request, mutation, cancellationToken), cancellationToken);

    private async Task<IngestTelemetryResult> Handle(IngestTelemetryCommand request, PowerMutation mutation, CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        var eventsRaised = new List<string>();

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        if (request.AcquisitionSessionId.HasValue && request.AcquisitionSequence.HasValue)
        {
            if (config.LastAcquisitionSessionId == request.AcquisitionSessionId
                && request.AcquisitionSequence.Value <= config.LastAcquisitionSequence)
            {
                // Duplicate/out-of-order acquisition: do not let retransmitted
                // telemetry count as another overload or recovery confirmation.
                return new IngestTelemetryResult(0, SystemState.Normal, 0, Array.Empty<string>());
            }
            config.LastAcquisitionSessionId = request.AcquisitionSessionId;
            config.LastAcquisitionSequence = request.AcquisitionSequence.Value;
        }
        else
        {
            // A legacy/unknown device cannot identify fresh batches or match
            // relay acknowledgements. Keep monitoring, but do not actuate it.
            config.LastAcquisitionSessionId = null;
            config.LastAcquisitionSequence = 0;
        }

        // Provenance is device-sourced (D8): it is only ever written from the
        // device's own report, never assumed here.
        if (request.MeteringMode is { } meteringMode)
        {
            config.MeteringMode = meteringMode;
            config.MeteringModeUpdatedAt = now;
        }

        var outlets = await _context.Outlets.ToListAsync(cancellationToken);
        var byId = outlets.ToDictionary(o => o.Id);

        var readingsStored = 0;
        foreach (var sample in request.Readings)
        {
            // The ESP32 may still be running firmware for a wider rig. Ignore
            // readings for channels that are not configured in this backend so
            // valid readings and the INA226 sample from the same batch can
            // still be persisted. Relay reports already use this behavior.
            if (!byId.TryGetValue(sample.OutletId, out var outlet))
            {
                continue;
            }

            var reading = new TelemetryReading
            {
                OutletId = outlet.Id,
                Timestamp = now,
                Voltage = sample.Voltage,
                CurrentAmps = sample.CurrentAmps,
                PowerWatts = sample.PowerWatts,
                EnergyKwh = sample.EnergyKwh,
            };
            _context.TelemetryReadings.Add(reading);
            mutation.StageReading(reading);

            outlet.CurrentWatts = sample.PowerWatts;
            outlet.LastSeen = now;
            readingsStored++;
        }

        // The INA226's own readings for THIS batch, stored against the same
        // `now` the branch rows above carry - that shared timestamp is what ties
        // the sensor numbers to the branch figures derived from them.
        //
        // Stored only when at least one field is actually reported. A present-but-
        // empty `ina` object means the firmware has the block and the sensor read
        // nothing; persisting four nulls would leave the dashboard with a fresh
        // timestamp and no data, i.e. a "live" sensor that has never reported.
        if (request.Ina is { } ina &&
            (ina.BusV.HasValue || ina.ShuntMv.HasValue || ina.CurrentA.HasValue || ina.PowerW.HasValue))
        {
            var inaReading = new InaReading
            {
                Timestamp = now,
                BusVoltageV = ina.BusV,
                ShuntVoltageMv = ina.ShuntMv,
                CurrentA = ina.CurrentA,
                PowerW = ina.PowerW,
            };
            _context.InaReadings.Add(inaReading);
            mutation.StageIna(inaReading);

            // On this four-branch bench, outlet 5 is the monitored USB/DC rail.
            // It has no relay or CT: mirror the INA226 sample into that outlet's
            // telemetry/history row so the dashboard shows five rows with live
            // USB watts while keeping the sensor's raw values in InaReadings too.
            var usbOutlet = outlets.FirstOrDefault(o => o.RelayChannel == "INA226 monitor");
            if (usbOutlet is not null)
            {
                var usbPower = ina.PowerW ?? (ina.BusV.HasValue && ina.CurrentA.HasValue
                    ? ina.BusV.Value * ina.CurrentA.Value
                    : 0.0);
                usbOutlet.CurrentWatts = usbPower;
                usbOutlet.LastSeen = now;
                var mirror = new TelemetryReading
                {
                    OutletId = usbOutlet.Id,
                    Timestamp = now,
                    Voltage = ina.BusV ?? usbOutlet.RatedVoltageVolts,
                    CurrentAmps = ina.CurrentA ?? 0.0,
                    PowerWatts = usbPower,
                    EnergyKwh = 0.0,
                };
                _context.TelemetryReadings.Add(mirror);
                mutation.StageReading(mirror);
                readingsStored++;
            }
        }

        foreach (var report in request.RelayStates)
        {
            if (!byId.TryGetValue(report.OutletId, out var outlet))
            {
                continue;
            }

            mutation.StageRelayReport(report.OutletId, report.RelayClosed, report.CommandId, now);

            // Backend restriction sticks until cleared by policy action.
            if (outlet.PendingCommandId is { } pendingId && report.CommandId == pendingId
                && outlet.PendingRelayClosed == report.RelayClosed)
            {
                // The ESP32 repeats the same command ID in every telemetry
                // batch until the backend clears it. Preserve the first ACK
                // time so a later fresh post-settle batch can clear the
                // pending command; refreshing this timestamp on every report
                // made the F3 wait condition impossible to satisfy.
                outlet.PendingCommandAcknowledgedAtUtc ??= now;
                if (outlet.PendingCommandOrigin is "automatic-shed" or "recovery-retry-off")
                {
                    outlet.NextRecoveryAtUtc = now.AddSeconds(LoadSheddingSettings.RecoveryPeriodSeconds);
                    outlet.RecoveryTrialPending = false;
                }
            }

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
                outlet.FaultHold = true;
            }

            AddEvent("Hardware fault isolation", "S_fault is TRUE: all relays restricted and the prototype isolated (POL-01).", EventSeverity.Critical, now, eventsRaised, mutation);
        }

        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name, o.IsProtected, o.ManualHold, o.RecoveryLockout, o.AutomaticRecoveryAttempts))
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
            // F3: no further automatic operation until this command has been
            // acknowledged by ID and at least one post-settle fresh batch exists.
            var pending = outlets.FirstOrDefault(o => o.PendingCommandId.HasValue);
            if (pending is not null && pending.PendingCommandIssuedAtUtc is { } issuedAt)
            {
                if (!pending.PendingCommandAcknowledgedAtUtc.HasValue
                    && now - issuedAt > TimeSpan.FromSeconds(LoadSheddingSettings.SwitchingResponseTimeoutSeconds))
                {
                    if (!pending.CommandNeedsReview)
                    {
                        pending.CommandNeedsReview = true;
                        AddEvent("Relay response needs review", $"{pending.Name} did not acknowledge command {pending.PendingCommandId} within {LoadSheddingSettings.SwitchingResponseTimeoutSeconds} seconds. Automatic switching is paused.", EventSeverity.Critical, now, eventsRaised, mutation);
                    }
                }
                else if (pending.PendingCommandAcknowledgedAtUtc is { } acknowledged
                    && outlets.Where(o => o.LastSeen.HasValue).All(o => o.LastSeen!.Value > acknowledged.AddMilliseconds(config.StabilizationDelayMs)))
                {
                    pending.PendingCommandId = null;
                    pending.PendingRelayClosed = null;
                    pending.PendingCommandOrigin = null;
                    pending.PendingCommandIssuedAtUtc = null;
                    pending.PendingCommandAcknowledgedAtUtc = null;
                }
            }

            shedding = RunFramework(outlets, config, now, eventsRaised, mutation);

            // The framework may have opened a relay, which changes P_total.
            // Re-derive it so the returned total and state describe the rig as
            // the framework just left it, not as it arrived.
            if (shedding is { Action: nameof(LoadSheddingAction.Shed) })
            {
                total = LoadResponseEvaluator.TotalLoad(outlets.Select(outlet => new OutletLoadSnapshot(
                    outlet.Id, outlet.Priority, outlet.Status, outlet.CurrentWatts, outlet.AllowanceWatts,
                    outlet.LastSeen, outlet.Name, outlet.IsProtected)));
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
                    eventsRaised,
                    mutation);
            }
        }

        await _context.SaveChangesAsync(cancellationToken);

        // Committed: publish the config, every outlet this batch loaded, its
        // readings, INA sample, relay reports and events (cached reads only).
        mutation.StageConfig(config);
        mutation.StageOutlets(outlets);
        mutation.MarkCommitted();

        return new IngestTelemetryResult(total, state, readingsStored, eventsRaised, shedding);
    }

    /// <summary>
    /// One framework tick: evaluate, apply the single decided action to the
    /// outlets, record it, and return what happened.
    /// </summary>
    private LoadSheddingResult RunFramework(
        IList<Outlet> outlets,
        PowerSystemConfig config,
        DateTimeOffset now,
        List<string> eventsRaised,
        PowerMutation mutation)
    {
        // P_limit is the existing critical threshold - the whole-system
        // operating limit POL-02..POL-07 already run on. No new config column.
        var pLimit = config.CriticalThresholdWatts;

        if (outlets.Any(o => o.CommandNeedsReview))
        {
            return MakeFrameworkResult(LoadSheddingAction.None, null, "Relay command response needs Admin review; automatic switching is paused.", pLimit, mutation.Framework, outlets);
        }
        if (outlets.Any(o => o.PendingCommandId.HasValue))
        {
            return MakeFrameworkResult(LoadSheddingAction.None, null, "Waiting for the matching relay acknowledgement and a fresh post-switch sample.", pLimit, mutation.Framework, outlets);
        }
        if (config.LastAcquisitionSessionId is null)
        {
            return MakeFrameworkResult(LoadSheddingAction.None, null, "Automatic switching is paused until firmware reports acquisition identity and command acknowledgements. Monitoring remains active.", pLimit, mutation.Framework, outlets);
        }
        if (outlets.Any(o => !o.LastSeen.HasValue || o.LastSeen < now.AddSeconds(-LoadSheddingSettings.SensorStalenessSeconds)))
        {
            return MakeFrameworkResult(LoadSheddingAction.None, null, "Fresh readings are required before automatic switching; missing or stale inputs are unknown, not zero.", pLimit, mutation.Framework, outlets);
        }

        // F3/F4: judge a recovery against the fresh demand after the settling
        // interval. If it failed, disconnect that same returning outlet.
        var recoveryTrial = outlets.FirstOrDefault(o => o.RecoveryTrialPending);
        if (recoveryTrial is not null)
        {
            var measuredTotal = outlets
                .Where(o => !LoadTierMapper.IsMonitoredOnlyOutlet(o.Id) && LoadResponseEvaluator.IsEnergized(o.Status))
                .Sum(o => o.CurrentWatts);
            if (measuredTotal >= pLimit)
            {
                recoveryTrial.RecoveryTrialOverLimitBatches++;
                if (recoveryTrial.RecoveryTrialOverLimitBatches >= LoadSheddingSettings.RecoveryTrialConfirmationBatches)
                {
                    recoveryTrial.Status = OutletStatus.Disconnected;
                    recoveryTrial.CommandedAtUtc = now;
                    recoveryTrial.PendingCommandId = Guid.NewGuid();
                    recoveryTrial.PendingRelayClosed = false;
                    recoveryTrial.PendingCommandOrigin = "recovery-retry-off";
                    recoveryTrial.PendingCommandIssuedAtUtc = now;
                    recoveryTrial.PendingCommandAcknowledgedAtUtc = null;
                    recoveryTrial.RecoveryTrialPending = false;
                    recoveryTrial.RecoveryTrialOverLimitBatches = 0;
                    recoveryTrial.NextRecoveryAtUtc = now.AddSeconds(LoadSheddingSettings.RecoveryPeriodSeconds);
                    if (recoveryTrial.AutomaticRecoveryAttempts >= 5) recoveryTrial.RecoveryLockout = true;
                    AddEvent(recoveryTrial.RecoveryLockout ? "Recovery locked out" : "Recovery trial reversed",
                        recoveryTrial.RecoveryLockout
                            ? $"{recoveryTrial.Name} remained over the operating limit after its fifth automatic reconnection. It is OFF and requires Admin review."
                            : $"The return of {recoveryTrial.Name} kept total demand above {pLimit:F0} W. That same outlet was disconnected; another trial is delayed {LoadSheddingSettings.RecoveryPeriodSeconds} seconds.",
                        recoveryTrial.RecoveryLockout ? EventSeverity.Critical : EventSeverity.Warning, now, eventsRaised, mutation);
                    return MakeFrameworkResult(LoadSheddingAction.Shed, recoveryTrial.Id, "Recovery attempt exceeded the threshold; disconnecting the same outlet.", pLimit, mutation.Framework, outlets);
                }
                return MakeFrameworkResult(LoadSheddingAction.None, recoveryTrial.Id, $"Checking recovery attempt ({recoveryTrial.RecoveryTrialOverLimitBatches}/{LoadSheddingSettings.RecoveryTrialConfirmationBatches} over-limit batches).", pLimit, mutation.Framework, outlets);
            }

            recoveryTrial.RecoveryTrialPending = false;
            recoveryTrial.RecoveryTrialOverLimitBatches = 0;
            recoveryTrial.NextRecoveryAtUtc = null;
            AddEvent("Recovery successful", $"{recoveryTrial.Name} remained connected after its fresh post-switch measurement.", EventSeverity.Success, now, eventsRaised, mutation);
        }

        var dueRecovery = outlets.Where(o => o.Status == OutletStatus.Disconnected && o.NextRecoveryAtUtc <= now
                && !o.ManualHold && !o.FaultHold && !o.RecoveryLockout && !o.IsProtected
                && !o.CommandNeedsReview && o.AutomaticRecoveryAttempts < 5
                && o.LastSeen >= now.AddSeconds(-LoadSheddingSettings.SensorStalenessSeconds))
            .OrderBy(o => o.Priority).ThenBy(o => o.Id).FirstOrDefault();
        if (dueRecovery is not null)
        {
            dueRecovery.Status = OutletStatus.Active;
            dueRecovery.CommandedAtUtc = now;
            dueRecovery.PendingCommandId = Guid.NewGuid();
            dueRecovery.PendingRelayClosed = true;
            dueRecovery.PendingCommandOrigin = "automatic-recovery";
            dueRecovery.PendingCommandIssuedAtUtc = now;
            dueRecovery.PendingCommandAcknowledgedAtUtc = null;
            dueRecovery.AutomaticRecoveryAttempts++;
            dueRecovery.RecoveryTrialPending = true;
            dueRecovery.RecoveryTrialOverLimitBatches = 0;
            AddEvent("Automatic recovery trial", $"Trial reconnection {dueRecovery.AutomaticRecoveryAttempts}/5 for {dueRecovery.Name}.", EventSeverity.Info, now, eventsRaised, mutation);
            return MakeFrameworkResult(LoadSheddingAction.Restore, dueRecovery.Id, $"Timed recovery elapsed; issuing trial {dueRecovery.AutomaticRecoveryAttempts}/5.", pLimit, mutation.Framework, outlets);
        }

        var decision = LoadSheddingEngine.Evaluate(
            outlets.Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name, o.IsProtected, o.ManualHold, o.RecoveryLockout, o.AutomaticRecoveryAttempts)).ToList(),
            pLimit,
            mutation.Framework,
            now);

        mutation.UpdateFramework(_ => decision.NextState);

        switch (decision.Action)
        {
            case LoadSheddingAction.Shed when decision.OutletId is { } shedId:
            {
                var shed = outlets.First(o => o.Id == shedId);
                shed.Status = OutletStatus.Disconnected;
                shed.CommandedAtUtc = now;
                shed.PendingCommandId = Guid.NewGuid();
                shed.PendingRelayClosed = false;
                shed.PendingCommandOrigin = "automatic-shed";
                shed.PendingCommandIssuedAtUtc = now;
                shed.PendingCommandAcknowledgedAtUtc = null;
                shed.NextRecoveryAtUtc = now.AddSeconds(LoadSheddingSettings.RecoveryPeriodSeconds);
                shed.RecoveryEpisodeId ??= Guid.NewGuid();

                AddEvent(
                    "Priority-based load shed",
                    decision.Detail,
                    EventSeverity.Warning,
                    now,
                    eventsRaised,
                    mutation);
                break;
            }

            case LoadSheddingAction.Restore when decision.OutletId is { } restoreId:
            {
                var restore = outlets.First(o => o.Id == restoreId);
                restore.Status = OutletStatus.Active;
                restore.CommandedAtUtc = now;
                restore.PendingCommandId = Guid.NewGuid();
                restore.PendingRelayClosed = true;
                restore.PendingCommandOrigin = "automatic-recovery";
                restore.PendingCommandIssuedAtUtc = now;
                restore.PendingCommandAcknowledgedAtUtc = null;
                restore.AutomaticRecoveryAttempts++;
                restore.RecoveryTrialPending = true;
                restore.RecoveryTrialOverLimitBatches = 0;

                AddEvent(
                    "Staged restoration",
                    decision.Detail,
                    EventSeverity.Info,
                    now,
                    eventsRaised,
                    mutation);
                break;
            }

            case LoadSheddingAction.Alarm:
                AddEvent(
                    "Load-shedding alarm",
                    decision.Detail,
                    EventSeverity.Critical,
                    now,
                    eventsRaised,
                    mutation);
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
            decision.OverLimitConfirmationSeconds,
            LoadSheddingSettings.RecoveryPeriodSeconds,
            decision.NextState.ShedLedger.Select(r => r.OutletId).ToList(),
            decision.NextState.ManualOverride,
            decision.NextState.FaultLatched);
    }

    private LoadSheddingResult MakeFrameworkResult(LoadSheddingAction action, int? outletId, string detail, double limit, LoadSheddingState state, IList<Outlet> outlets)
    {
        var outlet = outlets.FirstOrDefault(o => o.Id == outletId);
        return new LoadSheddingResult(action.ToString(), outletId, outlet?.Name, outlet is null ? null : LoadTierMapper.ToTier(outlet.Priority).ToString(), detail, limit, LoadSheddingEngine.ComputeRecoveryLimit(limit), state.ConsecutiveOverLimitBatches, LoadSheddingSettings.OverLimitConfirmationSeconds, LoadSheddingSettings.RecoveryPeriodSeconds, state.ShedLedger.Select(r => r.OutletId).ToList(), state.ManualOverride, state.FaultLatched);
    }

    private void AddEvent(string title, string detail, EventSeverity severity, DateTimeOffset now, List<string> raised, PowerMutation mutation)
    {
        var powerEvent = new PowerEvent
        {
            Timestamp = now,
            Title = title,
            Detail = detail,
            Severity = severity,
        };
        _context.PowerEvents.Add(powerEvent);
        mutation.StageEvent(powerEvent);

        raised.Add(title);
    }
}
