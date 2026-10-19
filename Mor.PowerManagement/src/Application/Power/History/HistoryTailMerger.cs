using System.Collections.Immutable;

namespace Mor.PowerManagement.Application.Power.History;

/// <summary>
/// One chart bucket for one outlet, kept as sums, counts and extrema so
/// contributions from the database and from memory can be merged before any
/// average, rounding or energy calculation (approved revision A).
/// </summary>
public readonly record struct HistoryBucketAggregate(
    int OutletId,
    DateTimeOffset BucketStart,
    double VoltageSum,
    double CurrentAmpsSum,
    double PowerWattsSum,
    long SampleCount,
    double EnergyKwh,
    double PeakWatts,
    double MinVolts,
    double MaxVolts,
    DateTimeOffset LatestSampleAt)
{
    public HistoryBucketAggregate Merge(HistoryBucketAggregate other) => this with
    {
        VoltageSum = VoltageSum + other.VoltageSum,
        CurrentAmpsSum = CurrentAmpsSum + other.CurrentAmpsSum,
        PowerWattsSum = PowerWattsSum + other.PowerWattsSum,
        SampleCount = SampleCount + other.SampleCount,
        EnergyKwh = Math.Max(EnergyKwh, other.EnergyKwh),
        PeakWatts = Math.Max(PeakWatts, other.PeakWatts),
        MinVolts = Math.Min(MinVolts, other.MinVolts),
        MaxVolts = Math.Max(MaxVolts, other.MaxVolts),
        LatestSampleAt = LatestSampleAt >= other.LatestSampleAt ? LatestSampleAt : other.LatestSampleAt,
    };

    public static HistoryBucketAggregate FromSample(in HistorySample sample, DateTimeOffset bucketStart, DateTimeOffset sampleAt) => new(
        sample.OutletId,
        bucketStart,
        sample.Voltage,
        sample.CurrentAmps,
        sample.PowerWatts,
        1,
        sample.EnergyKwh,
        sample.PowerWatts,
        sample.Voltage,
        sample.Voltage,
        sampleAt);
}

/// <summary>
/// The cached durable component of one chart window: database buckets read
/// with every contributing row at or below <see cref="Watermark"/>, over
/// [<see cref="From"/>, <see cref="To"/>). Immutable.
/// </summary>
public sealed record HistoryDurablePrefix(
    string Key,
    int BucketSeconds,
    long Watermark,
    DateTimeOffset From,
    DateTimeOffset To,
    ImmutableArray<HistoryBucketAggregate> Buckets);

/// <summary>
/// Chart tail merge for the existing 15m/1h/6h/24h/7d windows (Spec E item 12).
///
/// Only the durable component is cached, per window. Every request captures
/// the buffer's committed watermark and memory tail atomically, then:
///
/// - reuses a cached prefix only while the buffer's retained bridge still
///   covers everything committed since that prefix's watermark (otherwise it
///   is reloaded from the database at the captured watermark);
/// - merges prefix + bridge (committed after the prefix's watermark) + tail
///   (accepted after the captured watermark, in-flight included) as sums;
/// - so every row counts exactly once: database rows are bounded by the
///   prefix watermark, bridge rows by (prefix watermark, captured watermark],
///   tail rows by the captured watermark.
///
/// A final merged response is never cached.
/// </summary>
public sealed class HistoryTailMerger
{
    /// <summary>At most one prefix per window (the prefix holds every outlet; channel selection happens in the pivot).</summary>
    public const int MaxCachedPrefixes = 8;

    private readonly object _gate = new();
    private readonly SemaphoreSlim _durableWindow = new(1);
    private readonly Dictionary<string, HistoryDurablePrefix> _prefixes = new(StringComparer.Ordinal);
    private long _reloads;
    private long _hits;

    public long PrefixReloads => Interlocked.Read(ref _reloads);

    public long PrefixHits => Interlocked.Read(ref _hits);

    /// <summary>
    /// Serializes prefix misses (capture through database read) with maintenance.
    /// Rollups have no acquisition ordinal: maintenance must not move a concurrent
    /// flush into that unversioned tier while an older capture reads its prefix.
    /// Cached prefixes and live ingest never take this gate.
    /// </summary>
    public async Task<IDisposable> EnterDurableWindowAsync(CancellationToken cancellationToken)
    {
        await _durableWindow.WaitAsync(cancellationToken);
        return new DurableWindow(_durableWindow);
    }

    private sealed class DurableWindow(SemaphoreSlim gate) : IDisposable
    {
        public void Dispose() => gate.Release();
    }

    /// <summary>A cached prefix usable for this request, with the bridge acquisitions it still needs; null means reload.</summary>
    public (HistoryDurablePrefix Prefix, IReadOnlyList<AcceptedAcquisition> Bridge)? TryGetPrefix(
        string key, int bucketSeconds, DateTimeOffset from, HistoryTailCapture capture)
    {
        HistoryDurablePrefix? prefix;
        lock (_gate)
        {
            _prefixes.TryGetValue(key, out prefix);
        }

        if (prefix is null || prefix.BucketSeconds != bucketSeconds || prefix.From > from)
        {
            return null;
        }

        var bridge = capture.BridgeAfter(prefix.Watermark);
        if (bridge is null)
        {
            // The bridge would have to exceed its bound: invalidate and reload.
            Invalidate(key, prefix);
            return null;
        }

        Interlocked.Increment(ref _hits);
        return (prefix, bridge.ToList());
    }

    public void Store(HistoryDurablePrefix prefix)
    {
        Interlocked.Increment(ref _reloads);
        lock (_gate)
        {
            if (_prefixes.TryGetValue(prefix.Key, out var existing)
                && (existing.Watermark > prefix.Watermark || (existing.Watermark == prefix.Watermark && existing.From > prefix.From)))
            {
                return;
            }

            if (!_prefixes.ContainsKey(prefix.Key) && _prefixes.Count >= MaxCachedPrefixes)
            {
                _prefixes.Remove(_prefixes.MinBy(p => p.Value.Watermark).Key);
            }

            _prefixes[prefix.Key] = prefix;
        }
    }

    public void InvalidateAll()
    {
        lock (_gate)
        {
            _prefixes.Clear();
        }
    }

    private void Invalidate(string key, HistoryDurablePrefix prefix)
    {
        lock (_gate)
        {
            if (_prefixes.TryGetValue(key, out var current) && ReferenceEquals(current, prefix))
            {
                _prefixes.Remove(key);
            }
        }
    }

    /// <summary>
    /// Merges database buckets with memory acquisitions over [from, to) on the
    /// fixed bucket grid. Returned ordered by outlet, then bucket, like the
    /// database aggregate.
    /// </summary>
    public static List<HistoryBucketAggregate> Merge(
        IEnumerable<HistoryBucketAggregate> durable,
        IEnumerable<AcceptedAcquisition> memory,
        int bucketSeconds,
        DateTimeOffset epoch,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        var merged = new Dictionary<(int OutletId, long BucketTicks), HistoryBucketAggregate>();

        foreach (var bucket in durable)
        {
            if (bucket.BucketStart < from || bucket.BucketStart >= to)
            {
                continue;
            }

            Add(merged, bucket);
        }

        foreach (var acquisition in memory)
        {
            // Same predicate as the raw half of the database aggregate.
            if (acquisition.Timestamp < from || acquisition.Timestamp >= to)
            {
                continue;
            }

            var bucketStart = DateBin(acquisition.Timestamp, bucketSeconds, epoch);
            foreach (var sample in acquisition.Samples)
            {
                Add(merged, HistoryBucketAggregate.FromSample(sample, bucketStart, acquisition.Timestamp));
            }
        }

        return merged.Values
            .OrderBy(b => b.OutletId)
            .ThenBy(b => b.BucketStart)
            .ToList();
    }

    /// <summary>Floors a timestamp onto the fixed epoch grid, exactly like PostgreSQL date_bin and the query handler.</summary>
    public static DateTimeOffset DateBin(DateTimeOffset value, int bucketSeconds, DateTimeOffset epoch)
    {
        var stride = TimeSpan.TicksPerSecond * bucketSeconds;
        var sinceEpoch = value.UtcTicks - epoch.Ticks;
        var floored = sinceEpoch - (((sinceEpoch % stride) + stride) % stride);
        return epoch.AddTicks(floored);
    }

    private static void Add(Dictionary<(int, long), HistoryBucketAggregate> merged, HistoryBucketAggregate bucket)
    {
        var key = (bucket.OutletId, bucket.BucketStart.UtcTicks);
        merged[key] = merged.TryGetValue(key, out var existing) ? existing.Merge(bucket) : bucket;
    }
}
