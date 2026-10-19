namespace Mor.PowerManagement.Domain.Entities;

// One INA226 sample as the sensor itself measured it, for one telemetry batch.
//
// Deliberately NOT a TelemetryReading: a TelemetryReading is a per-outlet branch
// figure the firmware derived (amps x the shared mains volts), and the branch
// rows are indexed and pruned for the outlet graph. These four numbers are the
// DC-side sensor readings behind that derivation - bus volts, the mV across the
// shunt, the current through it and the power at the bus pin - so they are kept
// as their own series rather than smeared into the branch rows where the outlet
// semantics would be a lie.
//
// Every field is nullable: firmware older than the `ina` block simply posts no
// reading, and firmware that could not read the sensor posts a partial one.
// Every field is ALSO independent, because a shunt voltage without a current (or
// the reverse) is a real, reportable state of a half-working sensor rather than
// a reason to discard the whole sample.
//
// Timestamp is the batch timestamp (identical to the TelemetryReading rows of
// the same batch), which is what binds an InaReading to its batch.
public class InaReading : BaseEntity
{
    // V at the INA226 bus pin. mainsVolts_V (busV * INA226_MAIN_VOLT_DIVIDER)
    // is derived from this; the derived value is never stored here.
    public double? BusVoltageV { get; set; }

    // mV across the shunt resistor.
    public double? ShuntVoltageMv { get; set; }

    // A through the shunt.
    public double? CurrentA { get; set; }

    // W at the INA226 bus pin.
    public double? PowerW { get; set; }

    // When the batch that carried these readings was ingested.
    public DateTimeOffset Timestamp { get; set; }

    // Backend acquisition identity of the batch this sample arrived in; set
    // only by the batched history writer (see TelemetryReading).
    public long? AcquisitionOrdinal { get; set; }
}