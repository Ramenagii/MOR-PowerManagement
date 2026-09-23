using Mor.PowerManagement.Application.Common.Interfaces;
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
    OutletStatus DesiredStatus);

public record DeviceConfigVm(
    double MaxCapacityWatts,
    double WarningThresholdWatts,
    double CriticalThresholdWatts,
    double StandbyThresholdWatts,
    int StandbyIdleMinutes,
    int StabilizationDelayMs,
    IReadOnlyList<DeviceOutletPolicyDto> Outlets);

public class GetDeviceConfigQueryHandler : IRequestHandler<GetDeviceConfigQuery, DeviceConfigVm>
{
    private readonly IApplicationDbContext _context;

    public GetDeviceConfigQueryHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<DeviceConfigVm> Handle(GetDeviceConfigQuery request, CancellationToken cancellationToken)
    {
        var config = await _context.PowerSystemConfigs
            .FirstOrDefaultAsync(cancellationToken)
            ?? new PowerSystemConfig();

        var outlets = await _context.Outlets
            .OrderBy(o => o.Id)
            .Select(o => new DeviceOutletPolicyDto(
                o.Id, o.Priority, o.AllowanceWatts, o.RatedVoltageVolts, o.Schedule, o.IdleLimitMinutes, o.Status))
            .ToListAsync(cancellationToken);

        return new DeviceConfigVm(
            config.MaxCapacityWatts,
            config.WarningThresholdWatts,
            config.CriticalThresholdWatts,
            config.StandbyThresholdWatts,
            config.StandbyIdleMinutes,
            config.StabilizationDelayMs,
            outlets);
    }
}
