using System.Collections.Immutable;

namespace Mor.PowerManagement.Application.Power.History;

public enum HistoryAcceptance
{
    Buffered,

    /// <summary>The buffer was full: the acquisition was evaluated and published live; its history is part of a recorded gap.</summary>
    Dropped,
}

/// <summary>
/// What a chart request merges on top of the database, captured atomically:
/// every acquisition accepted after <see cref="CommittedWatermark"/>
/// (<see cref="Tail"/>, active and in-flight), and the retained committed
/// acquisitions in (<see cref="BridgeFloor"/>, <see cref="CommittedWatermark"/>]
/// (<see cref="Bridge"/>), ordered by ordinal.
/// </summary>
public sealed record HistoryTailCapture(
    long CommittedWatermark,
    long BridgeFloor,
    ImmutableArray<AcceptedAcquisition> Bridge,
    ImmutableArray<AcceptedAcquisition> Tail)
{
    /// <summary>
    /// Bridge acquisitions committed after <paramref name="watermark"/>, or
    /// null when the bridge no longer reaches back that far (the cached
    /// prefix must then be reloaded).
    /// </summary>
    public IEnumerable<AcceptedAcquisition>? BridgeAfter(long watermark)
        => watermark < BridgeFloor || watermark > CommittedWatermark ? null : Bridge.Where(a => a.Ordinal > watermark);
}

/// <summary>
/// The bounded in-memory history buffer (PLAN-0001 Spec E). Only the runtime
/// ingest handler adds to it, under the runtime write gate; the batch-window
/// coordinator drains it. Nothing here touches the database.
/// </summary>
public interface IHistoryBuffer
{
    /// <summary><c>Telemetry:BatchPersistenceEnabled</c>.</summary>
    bool Enabled { get; }

    /// <summary>The next backend acquisition ordinal. Gaps are allowed (a failed transition consumes one).</summary>
    long ReserveOrdinal();

    HistoryAcceptance Accept(AcceptedAcquisition acquisition);

    HistoryTailCapture CaptureTail();

    HistoryPersistenceStatus GetStatus();
}
