using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Queries.GetDashboardState;

public record GetDashboardStateQuery : IRequest<DashboardStateVm>;

public record OutletStateDto(
    int Id,
    string Name,
    string Role,
    string MeterChannel,
    string RelayChannel,
    OutletPriority Priority,
    double AllowanceWatts,
    int RatedVoltageVolts,
    double Watts,
    OutletStatus Status,
    string Schedule,
    int? IdleLimitMinutes,
    DateTimeOffset? LastSeen,
    // Thesis-facing tier, derived from Priority. Surfaced so the dashboard can
    // label tiers without re-implementing the mapping.
    LoadTier Tier,
    // Legacy policy flag. False for every outlet under the current framework
    // settings; priority does not exempt an outlet from its allowance.
    bool PerOutletCapExempt,
    // True when the framework (not the operator) shed this branch, i.e. it is
    // on the staged-restoration ladder.
    bool ShedByFramework);

public record ThresholdsDto(
    double MaxCapacityWatts,
    double WarningThresholdWatts,
    double CriticalThresholdWatts,
    double StandbyThresholdWatts,
    // Surfaced so the admin form can round-trip every field the
    // UpdateThresholdsCommand accepts. Without these the UI could write them
    // but never read them back, which made the setting invisible.
    int StandbyIdleMinutes,
    int StabilizationDelayMs);

public record PowerEventDto(
    int Id,
    DateTimeOffset Timestamp,
    string Title,
    string Detail,
    EventSeverity Severity);

public record FrameworkStateDto(
    bool AutomaticPrioritisationEnabled,
    bool FaultLatched,
    // P_total must fall below this (P_limit less the hysteresis band) before
    // anything is restored.
    double RecoveryLimitWatts,
    double HysteresisFraction,
    int OverLimitConfirmationBatches,
    int RecoveryPeriodSeconds,
    int InterReconnectDelaySeconds,
    int ConsecutiveOverLimitBatches,
    DateTimeOffset? BelowRecoveryLimitSinceUtc,
    IReadOnlyList<int> ShedOutletIds);

/// <summary>
/// The INA226's own last-reported readings. Distinct from
/// <see cref="DashboardStateVm.MainsVolts"/>, which is the DERIVED mains voltage
/// (bus volts x the divider ratio) the branch watts are computed against - this
/// is what the sensor actually measured, so an operator can see whether the
/// derived number has drifted or the sensor has gone quiet.
///
/// Every field is nullable because the sensor reports them independently; the
/// object itself is null when the latest stored reading is older than the
/// freshness window, so a stale reading can never be presented as live.
/// </summary>
public record Ina226StateDto(
    double? BusVolts,
    double? ShuntMillivolts,
    double? CurrentAmps,
    double? PowerWatts,
    DateTimeOffset? SampledAt);

public record DashboardStateVm(
    IReadOnlyList<OutletStateDto> Outlets,
    double TotalWatts,
    double RemainingWatts,
    double LoadPercent,
    SystemState State,
    int EnergizedCount,
    ThresholdsDto Thresholds,
    IReadOnlyList<PowerEventDto> RecentEvents,
    bool DeviceOnline,
    DateTimeOffset? DeviceLastSeen,
    FrameworkStateDto Framework,
    // Live INA226-derived mains volts (average of recent telemetry samples).
    // Null when no fresh device readings exist; UI falls back to rated volts.
    double? MainsVolts,
    // The INA226's own last sample, or null when none is fresh.
    Ina226StateDto? Ina226);

public class GetDashboardStateQueryHandler : IRequestHandler<GetDashboardStateQuery, DashboardStateVm>
{
    private readonly IApplicationDbContext _context;
    private readonly LoadSheddingStateStore _framework;

    public GetDashboardStateQueryHandler(IApplicationDbContext context, LoadSheddingStateStore framework)
    {
        _context = context;
        _framework = framework;
    }

    public async Task<DashboardStateVm> Handle(GetDashboardStateQuery request, CancellationToken cancellationToken)
    {
        var outlets = await _context.Outlets
            .OrderBy(o => o.Id)
            .ToListAsync(cancellationToken);

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var snapshots = outlets
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts, o.LastSeen, o.Name))
            .ToList();

        var total = LoadResponseEvaluator.TotalLoad(snapshots);
        var state = LoadResponseEvaluator.GetSystemState(total, config.WarningThresholdWatts, config.CriticalThresholdWatts);

        // ESP32 liveness: the device posts telemetry every 5s, so a recent
        // LastSeen means it is actively synced with the dashboard.
        var deviceLastSeen = outlets
            .Where(o => o.LastSeen.HasValue)
            .Select(o => o.LastSeen!.Value)
            .DefaultIfEmpty()
            .Max();
        var hasSeen = outlets.Any(o => o.LastSeen.HasValue);
        var deviceOnline = hasSeen && deviceLastSeen >= DateTimeOffset.UtcNow.AddSeconds(-30);

        var events = await _context.PowerEvents
            .OrderByDescending(e => e.Timestamp)
            .Take(20)
            .Select(e => new PowerEventDto(e.Id, e.Timestamp, e.Title, e.Detail, e.Severity))
            .ToListAsync(cancellationToken);

        var capExempt = LoadTierMapper.SelectCapExemptOutletIds(snapshots);
        var framework = _framework.Current;
        var shedByFramework = framework.ShedLedger.Select(r => r.OutletId).ToHashSet();

        // Live INA226 mains volts: average of fresh device samples from MAINS-
        // class outlets only. The USB socket posts the INA226 RAW bus volts
        // (~24 V, not divided), so including outlet 5 would drag a 227 V mean
        // down to ~187 V. Stale or absent readings yield null so the UI falls
        // back to rated volts instead of presenting a dead number as live.
        var mainsIds = outlets.Where(o => o.RatedVoltageVolts >= 100).Select(o => o.Id).ToList();
        var cutoff = DateTimeOffset.UtcNow.AddSeconds(-30);
        var mainsVolts = await _context.TelemetryReadings
            .Where(r => r.Timestamp >= cutoff && r.Voltage > 0 && mainsIds.Contains(r.OutletId))
            .Select(r => (double?)r.Voltage)
            .DefaultIfEmpty()
            .AverageAsync(cancellationToken);

        // The INA226's own last sample, from the same freshness window as
        // mainsVolts above: 30 s against a 5 s posting interval, so anything
        // older is a device that has stopped reporting. Reporting a stale row
        // would show a frozen number next to a live P_total and read as a sensor
        // fault that is not there, so the whole object is null instead - the UI
        // then shows nothing rather than something wrong.
        var latestIna = await _context.InaReadings
            .Where(r => r.Timestamp >= cutoff)
            .OrderByDescending(r => r.Timestamp)
            .FirstOrDefaultAsync(cancellationToken);

        var ina226 = latestIna is null
            ? null
            : new Ina226StateDto(
                latestIna.BusVoltageV,
                latestIna.ShuntVoltageMv,
                latestIna.CurrentA,
                latestIna.PowerW,
                latestIna.Timestamp);

        return new DashboardStateVm(
            outlets.Select(o => new OutletStateDto(
                o.Id, o.Name, o.Role, o.MeterChannel, o.RelayChannel,
                o.Priority, o.AllowanceWatts, o.RatedVoltageVolts, o.CurrentWatts, o.Status,
                o.Schedule, o.IdleLimitMinutes, o.LastSeen,
                LoadTierMapper.ToTier(o.Priority),
                capExempt.Contains(o.Id),
                shedByFramework.Contains(o.Id))).ToList(),
            total,
            Math.Max(config.MaxCapacityWatts - total, 0),
            config.MaxCapacityWatts <= 0 ? 0 : Math.Min(total / config.MaxCapacityWatts * 100, 100),
            state,
            snapshots.Count(s => LoadResponseEvaluator.IsEnergized(s.Status)),
            new ThresholdsDto(
                config.MaxCapacityWatts,
                config.WarningThresholdWatts,
                config.CriticalThresholdWatts,
                config.StandbyThresholdWatts,
                config.StandbyIdleMinutes,
                config.StabilizationDelayMs),
            events,
            deviceOnline,
            hasSeen ? deviceLastSeen : null,
            new FrameworkStateDto(
                !framework.ManualOverride,
                framework.FaultLatched,
                LoadSheddingEngine.ComputeRecoveryLimit(config.CriticalThresholdWatts),
                LoadSheddingSettings.RecoveryHysteresisFraction,
                LoadSheddingSettings.OverLimitConfirmationBatches,
                LoadSheddingSettings.RecoveryPeriodSeconds,
                LoadSheddingSettings.InterReconnectDelaySeconds,
                framework.ConsecutiveOverLimitBatches,
                framework.BelowRecoveryLimitSinceUtc,
                framework.ShedLedger.Select(r => r.OutletId).ToList()),
            mainsVolts,
            ina226);
    }
}
