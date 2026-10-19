using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Queries.GetDeviceConfig;

// Polled by the ESP32 to synchronize thresholds and the outlet policy table
// before it evaluates POL-01..POL-08 locally.
public record GetDeviceConfigQuery : IRequest<DeviceConfigVm>;

public record DeviceOutletPolicyDto(
    int ChannelId,
    OutletPriority Priority,
    double AllowanceWatts,
    int RatedVoltageVolts,
    string Schedule,
    int? IdleLimitMinutes,
    OutletStatus DesiredStatus,
    Guid? PendingCommandId);

public record DeviceConfigVm(
    double MaxCapacityWatts,
    double WarningThresholdWatts,
    double CriticalThresholdWatts,
    double StandbyThresholdWatts,
    int StandbyIdleMinutes,
    int StabilizationDelayMs,
    IReadOnlyList<DeviceOutletPolicyDto> Outlets,
    // Meter calibration, pushed to the device so the ZMCT103C front end can be
    // re-trimmed from the dashboard rather than by reflashing. All four are
    // properties of the hardware actually fitted.
    double ZmctCtRatio,
    double ZmctBurdenOhms,
    double ZmctPowerFactor,
    double ZmctGain);

public class GetDeviceConfigQueryHandler : IRequestHandler<GetDeviceConfigQuery, DeviceConfigVm>
{
    private readonly IApplicationDbContext _context;
    private readonly IPowerRuntimeStore? _runtime;

    public GetDeviceConfigQueryHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public GetDeviceConfigQueryHandler(IApplicationDbContext context, IPowerRuntimeStore runtime)
    {
        _context = context;
        _runtime = runtime;
    }

    public async Task<DeviceConfigVm> Handle(GetDeviceConfigQuery request, CancellationToken cancellationToken)
    {
        if (_runtime is { Enabled: true })
        {
            // Cached reads: no database access. The snapshot already holds the
            // committed configuration and every outlet's desired state.
            return Project(await _runtime.GetAsync(cancellationToken));
        }

        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets
            .OrderBy(o => o.Id)
            .Select(o => new DeviceOutletPolicyDto(
                o.Id, o.Priority, o.AllowanceWatts, o.RatedVoltageVolts, o.Schedule, o.IdleLimitMinutes, o.Status, o.PendingCommandId))
            .ToListAsync(cancellationToken);

        return new DeviceConfigVm(
            config.MaxCapacityWatts,
            config.WarningThresholdWatts,
            config.CriticalThresholdWatts,
            config.StandbyThresholdWatts,
            config.StandbyIdleMinutes,
            config.StabilizationDelayMs,
            outlets,
            config.ZmctCtRatio,
            config.ZmctBurdenOhms,
            config.ZmctPowerFactor,
            config.ZmctGain);
    }

    /// <summary>The legacy response, built from the runtime snapshot instead of two queries.</summary>
    public static DeviceConfigVm Project(PowerRuntimeSnapshot snapshot)
    {
        var config = snapshot.EffectiveConfig;

        return new DeviceConfigVm(
            config.MaxCapacityWatts,
            config.WarningThresholdWatts,
            config.CriticalThresholdWatts,
            config.StandbyThresholdWatts,
            config.StandbyIdleMinutes,
            config.StabilizationDelayMs,
            snapshot.Outlets
                .OrderBy(o => o.Id)
                .Select(o => new DeviceOutletPolicyDto(
                    o.Id, o.Priority, o.AllowanceWatts, o.RatedVoltageVolts, o.Schedule, o.IdleLimitMinutes, o.Status, o.PendingCommandId))
                .ToList(),
            config.ZmctCtRatio,
            config.ZmctBurdenOhms,
            config.ZmctPowerFactor,
            config.ZmctGain);
    }
}
