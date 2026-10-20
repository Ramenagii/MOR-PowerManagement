using System.Collections.Immutable;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.History;

namespace Mor.PowerManagement.Infrastructure.Power.History;

public sealed record HistoryBatch(Guid Id, ImmutableArray<AcceptedAcquisition> Acquisitions,
    long DroppedAcquisitions, long DroppedRows, DateTimeOffset? GapFrom, DateTimeOffset? GapTo);

/// <summary>One bounded queue including the batch in flight. Flushes share immutable acquisitions.</summary>
public sealed class BoundedHistoryBuffer(IOptions<HistoryPersistenceOptions> options, TimeProvider clock) : IHistoryBuffer
{
    private readonly object _gate = new();
    private readonly HistoryPersistenceOptions _options = options.Value;
    private readonly Queue<AcceptedAcquisition> _active = new();
    private readonly Queue<AcceptedAcquisition> _bridge = new();
    private HistoryBatch? _flight;
    private long _ordinal, _acceptedWatermark, _committed, _floor, _accepted, _written, _writtenRows, _drops, _dropRows, _recordedDrops, _bytes;
    private int _rows, _failures;
    private bool _initialized;
    private DateTimeOffset? _gapFrom, _gapTo, _lastAccepted;
    private HistoryFlushRecord? _lastFlush, _shutdown;
    private bool _breached;

    public bool Enabled => _options.BatchPersistenceEnabled;

    public void Initialize(long historyOrdinal, long liveOrdinal, long written, long writtenRows, long drops = 0, long dropRows = 0, DateTimeOffset? gapFrom = null, DateTimeOffset? gapTo = null)
    {
        lock (_gate)
        {
            if (_initialized) return;
            _ordinal = Math.Max(historyOrdinal, liveOrdinal);
            _acceptedWatermark = _ordinal;
            _committed = _floor = historyOrdinal;
            _drops = _recordedDrops = drops;
            _dropRows = dropRows;
            _gapFrom = gapFrom;
            _gapTo = gapTo;
            _written = written;
            _writtenRows = writtenRows;
            _initialized = true;
        }
    }

    public long ReserveOrdinal()
    {
        lock (_gate)
        {
            if (!_initialized) throw new InvalidOperationException("History writer must be initialized before accepting acquisitions.");
            return ++_ordinal;
        }
    }

    public HistoryAcceptance Accept(AcceptedAcquisition acquisition)
    {
        lock (_gate)
        {
            _accepted++;
            _acceptedWatermark = acquisition.Ordinal;
            _lastAccepted = clock.GetUtcNow();
            if (_active.Count + (_flight?.Acquisitions.Length ?? 0) >= _options.MaxBufferedAcquisitions
                || _rows + acquisition.RowCount > _options.MaxBufferedRows
                || _bytes + acquisition.AccountedBytes > _options.MaxBufferedBytes)
            {
                _drops++;
                _dropRows += acquisition.RowCount;
                _gapFrom ??= acquisition.Timestamp;
                _gapTo = acquisition.Timestamp;
                return HistoryAcceptance.Dropped;
            }
            _active.Enqueue(acquisition);
            _bytes += acquisition.AccountedBytes;
            _rows += acquisition.RowCount;
            return HistoryAcceptance.Buffered;
        }
    }

    public HistoryBatch? BeginBatch()
    {
        lock (_gate)
        {
            if (_flight is not null) return _flight; // stable identity on retry
            if (_active.Count == 0) return null;
            var items = ImmutableArray.CreateBuilder<AcceptedAcquisition>();
            while (_active.Count > 0 && items.Count < _options.MaxAcquisitionsPerBatch) items.Add(_active.Dequeue());
            return _flight = new(Guid.NewGuid(), items.ToImmutable(), _drops, _dropRows, _gapFrom, _gapTo);
        }
    }

    public void Complete(HistoryBatch batch, HistoryFlushRecord record)
    {
        lock (_gate)
        {
            if (!ReferenceEquals(_flight, batch)) throw new InvalidOperationException("Unexpected history batch completion.");
            foreach (var item in batch.Acquisitions)
            {
                _bytes -= item.AccountedBytes;
                _rows -= item.RowCount;
                _written++;
                _writtenRows += item.RowCount;
                _bridge.Enqueue(item);
            }
            _committed = batch.Acquisitions[^1].Ordinal;
            _recordedDrops = batch.DroppedAcquisitions;
            while (_bridge.Count > _options.BridgeMaxAcquisitions) _floor = _bridge.Dequeue().Ordinal;
            _flight = null;
            _lastFlush = record;
            _failures = 0;
        }
    }

    public void Failed(HistoryFlushRecord record)
    {
        lock (_gate) { _lastFlush = record; _failures++; }
    }

    public void RecordShutdown(HistoryFlushRecord record) { lock (_gate) _shutdown = record; }

    public bool IsDue()
    {
        lock (_gate)
        {
            var oldest = Oldest();
            var now = clock.GetUtcNow();
            return oldest.HasValue && (now - oldest >= TimeSpan.FromSeconds(_options.FlushIntervalSeconds - _options.FlushLeadSeconds)
                || now - _lastAccepted >= TimeSpan.FromSeconds(_options.InactivityFlushSeconds));
        }
    }

    public HistoryTailCapture CaptureTail()
    {
        lock (_gate) return new(_committed, _floor, _bridge.ToImmutableArray(),
            (_flight?.Acquisitions ?? ImmutableArray<AcceptedAcquisition>.Empty).Concat(_active).ToImmutableArray());
    }

    private DateTimeOffset? Oldest() => _flight?.Acquisitions[0].Timestamp ?? (_active.TryPeek(out var a) ? a.Timestamp : null);

    public HistoryPersistenceStatus GetStatus()
    {
        if (!Enabled) return HistoryPersistenceStatus.Synchronous;
        lock (_gate)
        {
            var oldest = Oldest();
            TimeSpan? age = oldest.HasValue ? clock.GetUtcNow() - oldest.Value : null;
            _breached |= age > _options.FlushInterval;
            return new(HistoryPersistenceMode.Batched, _initialized, _acceptedWatermark, _committed, _active.Count,
                _flight?.Acquisitions.Length ?? 0, _rows, _bytes, _bridge.Count, oldest, age, _options.FlushInterval,
                _breached, _breached ? "Uncommitted history exceeded the loss bound." : null,
                _accepted, _written, _writtenRows, _drops, _dropRows,
                _gapFrom.HasValue ? new[] { new HistoryGap(_gapFrom.Value, _gapTo!.Value, _drops, _dropRows,
                    _recordedDrops == _drops) } : Array.Empty<HistoryGap>(),
                _lastFlush, _failures, _shutdown);
        }
    }
}
