namespace Mor.PowerManagement.Domain.Enums;

// Provenance of the volt/current/power values the device reports. Numeric so it
// matches the project's existing numeric-enum serialisation over the wire, and
// so `MeteringMode = 0` on an old row reads as "device never told us".
public enum MeteringMode
{
    // The device has not reported a metering mode (pre-provenance firmware).
    Unknown = 0,

    // SIMULATE_METERS = 1: the ESP32 synthesises every reading on-device.
    Simulated = 1,

    // SIMULATE_METERS = 0: a real PZEM-004T is on the common mains feed.
    Metered = 2,

    // A ZMCT103C current transformer is wired on the common feed. It measures
    // CURRENT ONLY -- a CT has no voltage output, so volts are each channel's
    // nominal rating and watts are estimated as V_nominal x I x an assumed power
    // factor. Distinct from Metered so the UI cannot imply real power was
    // measured when it was not.
    EstimatedFromCurrent = 3,
}
