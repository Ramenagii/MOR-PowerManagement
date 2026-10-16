namespace Mor.PowerManagement.Domain.Entities;

using Mor.PowerManagement.Domain.Enums;

// Singleton row holding the system thresholds (P_limit and friends).
public class PowerSystemConfig : BaseAuditableEntity
{
    public double MaxCapacityWatts { get; set; } = 1300;

    public double WarningThresholdWatts { get; set; } = 1040;

    // P_limit: the operating limit driving POL-02..POL-07.
    public double CriticalThresholdWatts { get; set; } = 1300;

    // Branches at or below this draw count as standby load (POL-08 / idle shutdown).
    public double StandbyThresholdWatts { get; set; } = 80;

    public int StandbyIdleMinutes { get; set; } = 30;

    // Post-activation stabilization delay before verification (POL-04).
    public int StabilizationDelayMs { get; set; } = 500;

    public bool AutomaticPrioritisationEnabled { get; set; } = true;

    // Acquisition identity prevents a retransmitted old batch from satisfying
    // confirmation or post-switch verification.
    public Guid? LastAcquisitionSessionId { get; set; }

    public long LastAcquisitionSequence { get; set; }

    // Whether the reported readings are measured or synthesised. Written by
    // IngestTelemetry from the device's own meteringMode field; Unknown means the
    // device has not reported yet, which the UI states as "unknown" rather than
    // guessing either way.
    public MeteringMode MeteringMode { get; set; } = MeteringMode.Unknown;

    // When the device last reported a metering mode.
    public DateTimeOffset? MeteringModeUpdatedAt { get; set; }

    // -------------------------------------------------------------------------
    // Meter calibration (ZMCT103C + ADS1015 front end).
    //
    // These describe the hardware actually fitted, not the firmware build, so
    // they live in the database and are pushed to the ESP32 on every config
    // sync. A wrong CT ratio scales every reading by a constant factor, and the
    // ratio printed on the part is unreliable -- so this must be adjustable at
    // runtime rather than compiled in.
    //
    // Defaults match the compiled firmware fallbacks, so a device that has
    // never synced still behaves sensibly.
    // -------------------------------------------------------------------------

    // Primary:secondary turns ratio, e.g. 1000 for a 1000:1 CT.
    public double ZmctCtRatio { get; set; } = 1000;

    // Burden resistor in ohms converting CT secondary current to a voltage.
    public double ZmctBurdenOhms { get; set; } = 100;

    // Assumed power factor used to turn measured current into ESTIMATED watts.
    // A CT cannot measure phase, so this is the largest single error source in
    // reported wattage until a PZEM-004T is fitted.
    public double ZmctPowerFactor { get; set; } = 0.9;

    // Trim multiplier (measured / uncalibrated) tuned against a known load.
    public double ZmctGain { get; set; } = 1.0;
}
