namespace Mor.PowerManagement.Domain.Entities;

// One controlled laboratory outlet channel: socket + relay + PZEM meter + CT.
public class Outlet : BaseAuditableEntity
{
    public string Name { get; set; } = string.Empty;

    public string Role { get; set; } = string.Empty;

    public string MeterChannel { get; set; } = string.Empty;

    public string RelayChannel { get; set; } = string.Empty;

    // Mains rating of the channel: 220 (standard), 110 (transformer-fed) or 5 (USB).
    public int RatedVoltageVolts { get; set; } = 220;

    public OutletPriority Priority { get; set; } = OutletPriority.Low;

    // Expected branch draw used by the pre-activation assessment (POL-02 / POL-03).
    public double AllowanceWatts { get; set; }

    public string Schedule { get; set; } = string.Empty;

    // Idle limit in minutes; null means the outlet is exempt from idle shutdown.
    public int? IdleLimitMinutes { get; set; }

    // Live state, updated by telemetry ingest and policy actions.
    public OutletStatus Status { get; set; } = OutletStatus.Disconnected;

    // Last dashboard command time (activation/disconnection). Telemetry must
    // not overwrite the commanded state until the device has had time to
    // confirm it (it polls config every ~15s, telemetry runs every ~5s).
    public DateTimeOffset? CommandedAtUtc { get; set; }

    public double CurrentWatts { get; set; }

    public DateTimeOffset? LastSeen { get; set; }

    public IList<TelemetryReading> Readings { get; private set; } = new List<TelemetryReading>();
}
