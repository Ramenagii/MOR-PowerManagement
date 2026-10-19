using System.Collections.Immutable;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.History;

/// <summary>One outlet (or monitor-mirror) measurement row, exactly as the legacy path would insert it.</summary>
public readonly record struct HistorySample(int OutletId, double Voltage, double CurrentAmps, double PowerWatts, double EnergyKwh);

/// <summary>The INA226's own reading for the acquisition, independently nullable like <c>InaReading</c>.</summary>
public sealed record HistoryInaSample(double? BusVoltageV, double? ShuntVoltageMv, double? CurrentA, double? PowerW);

public readonly record struct OutletLiveState(int OutletId, double CurrentWatts, DateTimeOffset? LastSeen);

/// <summary>
/// The acquisition safeguards and display fields this acquisition left in
/// memory: the identity used for duplicate detection, metering provenance,
/// and each outlet's live watts and last-seen time. Persisted with batch
/// checkpoints. <see cref="ConfigId"/> is 0 when no configuration row exists
/// (the legacy path persists nothing then either).
/// </summary>
public sealed record AcquisitionLiveState(
    int ConfigId,
    Guid? LastAcquisitionSessionId,
    long LastAcquisitionSequence,
    MeteringMode MeteringMode,
    DateTimeOffset? MeteringModeUpdatedAt,
    ImmutableArray<OutletLiveState> Outlets);

/// <summary>
/// One accepted acquisition held for history persistence. Immutable: the
/// buffer, a flush in flight and chart snapshots share the same instance and
/// never copy it.
/// </summary>
public sealed class AcceptedAcquisition
{
    // Conservative accounting constants (bytes). They overstate the CLR sizes:
    // object headers, the immutable arrays, the live-state record and the
    // buffer's list slots are all inside the fixed part.
    public const int FixedOverheadBytes = 512;

    public const int SampleBytes = 96;

    public const int InaBytes = 128;

    public const int OutletLiveBytes = 48;

    public AcceptedAcquisition(long ordinal, DateTimeOffset timestamp, ImmutableArray<HistorySample> samples, HistoryInaSample? ina, AcquisitionLiveState live)
    {
        Ordinal = ordinal;
        Timestamp = timestamp;
        Samples = samples.IsDefault ? ImmutableArray<HistorySample>.Empty : samples;
        Ina = ina;
        Live = live;
        AccountedBytes = FixedOverheadBytes
            + (long)Samples.Length * SampleBytes
            + (ina is null ? 0 : InaBytes)
            + (long)(live.Outlets.IsDefault ? 0 : live.Outlets.Length) * OutletLiveBytes;
    }

    /// <summary>Backend acquisition identity: monotonic per database, assigned under the runtime write gate.</summary>
    public long Ordinal { get; }

    /// <summary>The acquisition's timestamp, microsecond-normalized like the stored value.</summary>
    public DateTimeOffset Timestamp { get; }

    /// <summary>Outlet rows in insertion order; a row's sample ordinal is its index.</summary>
    public ImmutableArray<HistorySample> Samples { get; }

    public HistoryInaSample? Ina { get; }

    public AcquisitionLiveState Live { get; }

    /// <summary>Measurement rows this acquisition writes: outlet rows (mirror included) plus the INA226 row.</summary>
    public int RowCount => Samples.Length + (Ina is null ? 0 : 1);

    public long AccountedBytes { get; }
}
