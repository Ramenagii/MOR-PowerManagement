namespace Mor.PowerManagement.Domain.Entities;

// Durable progress of seven-day raw compaction (PLAN-0001 Spec F). One row per
// raw stream:
//
// - "telemetry": TelemetryReadings -> TelemetryMinuteRollups and
//   TelemetryReadingRollups (five-minute).
// - "ina": InaReadings -> InaMinuteRollups.
//
// Each compaction transaction locks its stream's row (FOR UPDATE SKIP LOCKED),
// so concurrent runners never compact the same stream at once, and advances the
// counters in the same transaction as the rows it moved. A run that stops at
// its deadline simply leaves older raw rows for the next maintenance window;
// raw rows are the work queue, so nothing is skipped.
//
// Rows are created on first use (upsert), not seeded.
public class TelemetryCompactionCheckpoint
{
    public const string TelemetryStream = "telemetry";

    public const string InaStream = "ina";

    public string Stream { get; set; } = string.Empty;

    // First compaction by the seven-day path. Minute summaries exist only for
    // raw rows compacted at or after this cutoff; older history was compacted
    // by the legacy six-hour path into five-minute rollups only.
    public DateTimeOffset? MinuteCoverageFromUtc { get; set; }

    // The raw cutoff of the last committed batch: every raw row older than this
    // had been compacted when that batch committed, unless it arrived later.
    public DateTimeOffset? LastCutoffUtc { get; set; }

    public DateTimeOffset? LastCompactedAtUtc { get; set; }

    public long CompactedRows { get; set; }

    public long CompactedBatches { get; set; }

    public int LastBatchRows { get; set; }
}
