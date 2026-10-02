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
}
