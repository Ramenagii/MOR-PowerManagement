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

    // Backend acquisition identity (PLAN-0001 Spec E). Set only by the batched
    // history writer: a monotonic per-database ordinal of the accepted
    // acquisition and this row's position inside it. Null on rows written by
    // the legacy and runtime/synchronous paths. The history query uses the
    // ordinal to read exactly the committed side of a memory-tail merge.
    public long? AcquisitionOrdinal { get; set; }

    public short? SampleOrdinal { get; set; }
}
