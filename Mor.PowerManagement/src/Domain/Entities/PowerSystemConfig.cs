namespace Mor.PowerManagement.Domain.Entities;

using Mor.PowerManagement.Domain.Enums;

// Singleton row holding the system thresholds (P_limit and friends).
public class PowerSystemConfig : BaseAuditableEntity
{
    public double MaxCapacityWatts { get; set; } = 2200;

    public double WarningThresholdWatts { get; set; } = 1800;

    // P_limit: the operating limit driving POL-02..POL-07.
    public double CriticalThresholdWatts { get; set; } = 2000;

    // Branches at or below this draw count as standby load (POL-08 / idle shutdown).
    public double StandbyThresholdWatts { get; set; } = 80;

    public int StandbyIdleMinutes { get; set; } = 30;

    // Post-activation stabilization delay before verification (POL-04).
    public int StabilizationDelayMs { get; set; } = 500;

    // Whether the reported readings are measured or synthesised. Written by
    // IngestTelemetry from the device's own meteringMode field; Unknown means the
    // device has not reported yet, which the UI states as "unknown" rather than
    // guessing either way.
    public MeteringMode MeteringMode { get; set; } = MeteringMode.Unknown;

    // When the device last reported a metering mode.
    public DateTimeOffset? MeteringModeUpdatedAt { get; set; }
}
