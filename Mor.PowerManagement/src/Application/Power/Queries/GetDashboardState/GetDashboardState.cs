using Mor.PowerManagement.Application.Common.Interfaces;
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
    DateTimeOffset? LastSeen);

public record ThresholdsDto(
    double MaxCapacityWatts,
    double WarningThresholdWatts,
    double CriticalThresholdWatts,
    double StandbyThresholdWatts);

public record PowerEventDto(
    int Id,
    DateTimeOffset Timestamp,
    string Title,
    string Detail,
    EventSeverity Severity);

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
    DateTimeOffset? DeviceLastSeen);

public class GetDashboardStateQueryHandler : IRequestHandler<GetDashboardStateQuery, DashboardStateVm>
{
    private readonly IApplicationDbContext _context;

    public GetDashboardStateQueryHandler(IApplicationDbContext context)
    {
        _context = context;
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
            .Select(o => new OutletLoadSnapshot(o.Id, o.Priority, o.Status, o.CurrentWatts, o.AllowanceWatts))
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

        return new DashboardStateVm(
            outlets.Select(o => new OutletStateDto(
                o.Id, o.Name, o.Role, o.MeterChannel, o.RelayChannel,
                o.Priority, o.AllowanceWatts, o.RatedVoltageVolts, o.CurrentWatts, o.Status,
                o.Schedule, o.IdleLimitMinutes, o.LastSeen)).ToList(),
            total,
            Math.Max(config.MaxCapacityWatts - total, 0),
            config.MaxCapacityWatts <= 0 ? 0 : Math.Min(total / config.MaxCapacityWatts * 100, 100),
            state,
            snapshots.Count(s => LoadResponseEvaluator.IsEnergized(s.Status)),
            new ThresholdsDto(
                config.MaxCapacityWatts,
                config.WarningThresholdWatts,
                config.CriticalThresholdWatts,
                config.StandbyThresholdWatts),
            events,
            deviceOnline,
            hasSeen ? deviceLastSeen : null);
    }
}
