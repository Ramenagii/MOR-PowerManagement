namespace Mor.PowerManagement.Domain.Entities;

// The INA226 series for one UTC minute, summarized when raw InaReadings age out
// of the seven-day raw tier (PLAN-0001 Spec F). Kept through day 30.
//
// InaReading fields are independently nullable (a half-working sensor reports
// some of them), so each field carries its own count: a mean is
// <Field>Sum / <Field>Count, never <Field>Sum / SampleCount, and a field with
// Count 0 has NULL Sum/Min/Max rather than a fabricated zero. SampleCount is
// the number of rows, including rows where every field was NULL.
public class InaMinuteRollup
{
    public DateTimeOffset BucketStart { get; set; }

    public long SampleCount { get; set; }

    public long BusVoltageVCount { get; set; }

    public double? BusVoltageVSum { get; set; }

    public double? MinBusVoltageV { get; set; }

    public double? MaxBusVoltageV { get; set; }

    public long ShuntVoltageMvCount { get; set; }

    public double? ShuntVoltageMvSum { get; set; }

    public double? MinShuntVoltageMv { get; set; }

    public double? MaxShuntVoltageMv { get; set; }

    public long CurrentACount { get; set; }

    public double? CurrentASum { get; set; }

    public double? MinCurrentA { get; set; }

    public double? MaxCurrentA { get; set; }

    public long PowerWCount { get; set; }

    public double? PowerWSum { get; set; }

    public double? MinPowerW { get; set; }

    public double? MaxPowerW { get; set; }

    public DateTimeOffset FirstSampleAt { get; set; }

    public DateTimeOffset LatestSampleAt { get; set; }
}
