namespace Mor.PowerManagement.Application.Power.History;

public enum HistoryPersistenceMode
{
    /// <summary>Rows are written by the ingest request itself (legacy or runtime/synchronous).</summary>
    Synchronous,

    /// <summary>Rows are buffered and written in bounded batches.</summary>
    Batched,
}

/// <summary>
/// A run of acquisitions whose history was dropped because the buffer was
/// full. <see cref="Recorded"/> turns true once the counts are written to the
/// history checkpoint with a later successful batch.
/// </summary>
public sealed record HistoryGap(DateTimeOffset FromUtc, DateTimeOffset ToUtc, long DroppedAcquisitions, long DroppedRows, bool Recorded);

public sealed record HistoryFlushRecord(
    DateTimeOffset StartedAtUtc,
    TimeSpan Duration,
    string Trigger,
    string Outcome,
    int Acquisitions,
    int Rows,
    string? Error);

/// <summary>
/// Point-in-time view of the batched history writer. "Accepted" rows are only
/// in memory; only "committed" rows are durable.
/// </summary>
public sealed record HistoryPersistenceStatus(
    HistoryPersistenceMode Mode,
    bool Initialized,
    long AcceptedWatermark,
    long CommittedWatermark,
    int ActiveAcquisitions,
    int InFlightAcquisitions,
    int BufferedRows,
    long AccountedBytes,
    int BridgeAcquisitions,
    DateTimeOffset? OldestUncommittedAtUtc,
    TimeSpan? OldestUncommittedAge,
    TimeSpan LossBound,
    bool LossGuaranteeBreached,
    string? BreachReason,
    long TotalAcceptedAcquisitions,
    long TotalCommittedAcquisitions,
    long TotalCommittedRows,
    long TotalDroppedAcquisitions,
    long TotalDroppedRows,
    IReadOnlyList<HistoryGap> Gaps,
    HistoryFlushRecord? LastFlush,
    int ConsecutiveFlushFailures,
    HistoryFlushRecord? ShutdownFlush)
{
    public static HistoryPersistenceStatus Synchronous { get; } = new(
        HistoryPersistenceMode.Synchronous, true, 0, 0, 0, 0, 0, 0, 0, null, null, TimeSpan.Zero, false, null,
        0, 0, 0, 0, 0, Array.Empty<HistoryGap>(), null, 0, null);

    /// <summary>
    /// True while history is unaccounted for in this process: a dropped run,
    /// or the measured loss exposure exceeded the bound. Persistence
    /// acceptance fails while this is true.
    /// </summary>
    public bool AcceptanceFailing => LossGuaranteeBreached || Gaps.Count > 0;
}
