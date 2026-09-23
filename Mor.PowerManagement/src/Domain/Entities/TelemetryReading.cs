namespace Mor.PowerManagement.Domain.Entities;

// One PZEM-004T v3.0 sample for an outlet branch, reported by the ESP32.
public class TelemetryReading : BaseEntity
{
    public int OutletId { get; set; }

    public Outlet Outlet { get; set; } = null!;

    public DateTimeOffset Timestamp { get; set; }

    public double Voltage { get; set; }

    public double CurrentAmps { get; set; }

    public double PowerWatts { get; set; }

    public double EnergyKwh { get; set; }
}
