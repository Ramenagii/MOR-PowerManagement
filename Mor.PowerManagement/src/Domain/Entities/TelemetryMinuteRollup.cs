namespace Mor.PowerManagement.Domain.Entities;

// One outlet's raw TelemetryReadings for one UTC minute, summarized when the
// rows age out of the seven-day raw tier (PLAN-0001 Spec F). Kept through day
// 30. Buckets are date_bin('1 minute', Timestamp, 2001-01-01Z), the same epoch
// as the five-minute TelemetryReadingRollups, so exactly five minute buckets
// nest inside each five-minute bucket.
//
// Every raw row is summarized exactly once: compaction deletes the raw rows and
// upserts their contribution in the same transaction. A bucket can be written
// by several transactions (a batch boundary falling inside the minute, or a
// late row), so every column merges: sums and counts add, extrema take
// LEAST/GREATEST, first/last keep the earliest/latest sample.
//
// Raw outlet fields are NOT NULL, so SampleCount is the denominator of every
// mean (VoltageSum / SampleCount, ...).
public class TelemetryMinuteRollup
{
    public int OutletId { get; set; }

    public DateTimeOffset BucketStart { get; set; }

    public long SampleCount { get; set; }

    public double VoltageSum { get; set; }

    public double CurrentAmpsSum { get; set; }

    public double PowerWattsSum { get; set; }

    public double MinVoltage { get; set; }

    public double MaxVoltage { get; set; }

    public double MinCurrentAmps { get; set; }

    public double MaxCurrentAmps { get; set; }

    public double MinPowerWatts { get; set; }

    public double MaxPowerWatts { get; set; }

    // Energy is a cumulative counter: first/last bound the minute, and the
    // maximum answers the chart's MAX(EnergyKwh) per bucket exactly.
    public double FirstEnergyKwh { get; set; }

    public DateTimeOffset FirstSampleAt { get; set; }

    public double LastEnergyKwh { get; set; }

    public double MaxEnergyKwh { get; set; }

    public DateTimeOffset LatestSampleAt { get; set; }
}
