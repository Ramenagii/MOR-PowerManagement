namespace Mor.PowerManagement.Domain.Entities;

// Durable progress of the batched history writer (PLAN-0001 Spec E). One row
// per stream:
//
// - "history": the committed watermark. LastCommittedOrdinal is the highest
//   acquisition ordinal whose rows are committed; it advances in the same
//   transaction as the rows, so after an uncertain commit the writer can tell
//   whether its batch is already durable.
// - "live-state": the ordinal of the acquisition whose identity
//   (PowerSystemConfigs.LastAcquisition*, MeteringMode*) and outlet
//   CurrentWatts/LastSeen were last persisted. Immediate control transactions
//   and batch checkpoints both write it, and a checkpoint only writes when its
//   ordinal is newer, so an older checkpoint never overwrites newer state.
//
// Rows are created on first use (upsert), not seeded.
public class TelemetryPersistenceCheckpoint
{
    public const string HistoryStream = "history";

    public const string LiveStateStream = "live-state";

    public string Stream { get; set; } = string.Empty;

    public long LastCommittedOrdinal { get; set; }

    public Guid? LastBatchId { get; set; }

    public DateTimeOffset? LastCommittedAtUtc { get; set; }

    // Cumulative totals written by the history stream.
    public long CommittedAcquisitions { get; set; }

    public long CommittedRows { get; set; }

    // Cumulative history lost to buffer overflow, recorded with the next
    // successful batch so the gap is durable evidence, not only a log line.
    public long DroppedAcquisitions { get; set; }

    public long DroppedRows { get; set; }

    public DateTimeOffset? LastGapFromUtc { get; set; }

    public DateTimeOffset? LastGapToUtc { get; set; }
}
