using System.Collections.Concurrent;
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Mor.PowerManagement.Infrastructure.Observability;

/// <summary>
/// Observes EF Core command execution without replacing any provider object.
/// The reader EF receives is always the provider's own reader: providers cast
/// it (Npgsql's modification batch casts to NpgsqlDataReader for SaveChanges
/// and RETURNING), so wrapping it would change behavior.
///
/// Reader rows come from EF's own read count, reported when EF closes and
/// disposes its RelationalDataReader. Nothing here calls Read, reads a value,
/// or enumerates a result.
/// </summary>
public sealed class TelemetryDatabaseInterceptor(TelemetryDatabaseMetrics metrics) : DbCommandInterceptor
{
    // Commands between Executing and Executed/Failed/Canceled.
    private readonly ConcurrentDictionary<Guid, TelemetryMeasurementCommand> _pending = new();

    // Reader commands whose execution succeeded and whose reader EF still owns.
    private readonly ConcurrentDictionary<Guid, TelemetryMeasurementCommand> _openReaders = new();

    private void Begin(DbCommand command, CommandEventData data, TelemetryCommandKind kind)
        => _pending[data.CommandId] = metrics.BeginCommand(kind, command.CommandText);

    private void Finish(CommandEndEventData data, long rowsReturned, long rowsAffected, long bytes)
    {
        if (_pending.TryRemove(data.CommandId, out var pending))
            metrics.RecordCompleted(pending, data.Duration, rowsReturned, rowsAffected, bytes);
    }

    private void Fail(CommandEndEventData data, bool canceled)
    {
        if (_pending.TryRemove(data.CommandId, out var pending))
            metrics.RecordFailed(pending, data.Duration, canceled);
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r) { Begin(c, e, TelemetryCommandKind.Reader); return r; }
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r, CancellationToken t = default) => new(ReaderExecuting(c, e, r));
    public override InterceptionResult<object> ScalarExecuting(DbCommand c, CommandEventData e, InterceptionResult<object> r) { Begin(c, e, TelemetryCommandKind.Scalar); return r; }
    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<object> r, CancellationToken t = default) => new(ScalarExecuting(c, e, r));
    public override InterceptionResult<int> NonQueryExecuting(DbCommand c, CommandEventData e, InterceptionResult<int> r) { Begin(c, e, TelemetryCommandKind.NonQuery); return r; }
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<int> r, CancellationToken t = default) => new(NonQueryExecuting(c, e, r));

    public override int NonQueryExecuted(DbCommand c, CommandExecutedEventData e, int r) { Finish(e, 0, Math.Max(0, r), 0); return r; }
    public override ValueTask<int> NonQueryExecutedAsync(DbCommand c, CommandExecutedEventData e, int r, CancellationToken t = default) => new(NonQueryExecuted(c, e, r));
    public override object? ScalarExecuted(DbCommand c, CommandExecutedEventData e, object? r) { Finish(e, r is null or DBNull ? 0 : 1, 0, TelemetryResultEstimate.Scalar(r)); return r; }
    public override ValueTask<object?> ScalarExecutedAsync(DbCommand c, CommandExecutedEventData e, object? r, CancellationToken t = default) => new(ScalarExecuted(c, e, r));

    // Returns the provider reader unchanged. Only result-set metadata (field
    // count and CLR field types) is inspected; it is already loaded once
    // execution returns and inspecting it does not advance the reader.
    public override DbDataReader ReaderExecuted(DbCommand c, CommandExecutedEventData e, DbDataReader r)
    {
        if (_pending.TryRemove(e.CommandId, out var pending))
        {
            pending.ExecutionDuration = e.Duration;
            pending.EstimatedRowBytes = TelemetryResultEstimate.RowBytes(r);
            _openReaders[e.CommandId] = pending;
        }

        return r;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand c, CommandExecutedEventData e, DbDataReader r, CancellationToken t = default) => new(ReaderExecuted(c, e, r));

    public override void CommandFailed(DbCommand c, CommandErrorEventData e) => Fail(e, e.Exception is OperationCanceledException);
    public override Task CommandFailedAsync(DbCommand c, CommandErrorEventData e, CancellationToken t = default) { CommandFailed(c, e); return Task.CompletedTask; }
    public override void CommandCanceled(DbCommand c, CommandEndEventData e) => Fail(e, true);
    public override Task CommandCanceledAsync(DbCommand c, CommandEndEventData e, CancellationToken t = default) { Fail(e, true); return Task.CompletedTask; }

    // EF raises Closing (when its reader is still open) and then Disposing. The
    // command is recorded at Disposing, when the reader has been closed and the
    // provider's RecordsAffected covers every statement in a SaveChanges batch.
    // Neither callback is suppressed; EF closes and disposes as it always does.
    public override InterceptionResult DataReaderClosing(DbCommand c, DataReaderClosingEventData e, InterceptionResult r) => r;
    public override ValueTask<InterceptionResult> DataReaderClosingAsync(DbCommand c, DataReaderClosingEventData e, InterceptionResult r) => new(r);

    public override InterceptionResult DataReaderDisposing(DbCommand c, DataReaderDisposingEventData e, InterceptionResult r)
    {
        if (_openReaders.TryRemove(e.CommandId, out var pending))
        {
            // ReadCount counts Read() calls made through EF, including the
            // final call of a fully enumerated result set that returned false.
            var reads = Math.Max(0, e.ReadCount);
            metrics.RecordCompleted(
                pending,
                pending.ExecutionDuration,
                rowsReturned: reads,
                rowsAffected: Math.Max(0, e.RecordsAffected),
                estimatedResultBytes: reads * pending.EstimatedRowBytes,
                readerReadCalls: reads,
                readerOpenDuration: e.Duration);
        }

        return r;
    }
}

public sealed class TelemetryConnectionInterceptor(TelemetryDatabaseMetrics metrics) : DbConnectionInterceptor
{
    public override void ConnectionOpened(DbConnection c, ConnectionEndEventData e) => metrics.RecordConnectionOpened(true);
    public override Task ConnectionOpenedAsync(DbConnection c, ConnectionEndEventData e, CancellationToken t = default) { metrics.RecordConnectionOpened(true); return Task.CompletedTask; }
    public override void ConnectionFailed(DbConnection c, ConnectionErrorEventData e) => metrics.RecordConnectionOpened(false);
    public override Task ConnectionFailedAsync(DbConnection c, ConnectionErrorEventData e, CancellationToken t = default) { metrics.RecordConnectionOpened(false); return Task.CompletedTask; }
}

/// <summary>
/// ESTIMATED PostgreSQL result payload. Derived from row counts and column
/// metadata only, never from values: fixed-width types use their wire width
/// and variable-width types use a nominal width. It is not Neon network
/// transfer and excludes RowDescription/CommandComplete messages, TLS and
/// rows the server sent that the backend never read.
/// </summary>
public static class TelemetryResultEstimate
{
    // DataRow message: type byte, int32 length, int16 column count.
    public const int RowHeaderBytes = 7;

    // Each column carries an int32 length prefix before its value.
    public const int FieldHeaderBytes = 4;

    public const int NominalTextBytes = 32;
    public const int NominalBinaryBytes = 64;
    public const int NominalOtherBytes = 16;

    public static long RowBytes(DbDataReader reader)
    {
        try
        {
            if (reader.IsClosed)
            {
                return RowHeaderBytes;
            }

            var bytes = (long)RowHeaderBytes;
            for (var i = 0; i < reader.FieldCount; i++)
            {
                bytes += FieldHeaderBytes + FieldBytes(reader.GetFieldType(i));
            }

            return bytes;
        }
        catch (Exception)
        {
            // Metadata unavailable for this result; never let measurement
            // surface an error to EF. The row header alone is still counted.
            return RowHeaderBytes;
        }
    }

    public static int FieldBytes(Type? type) => type switch
    {
        null => NominalOtherBytes,
        _ when type == typeof(bool) || type == typeof(byte) || type == typeof(sbyte) => 1,
        _ when type == typeof(short) || type == typeof(ushort) || type == typeof(char) => 2,
        _ when type == typeof(int) || type == typeof(uint) || type == typeof(float) => 4,
        _ when type == typeof(long) || type == typeof(ulong) || type == typeof(double)
            || type == typeof(DateTime) || type == typeof(DateTimeOffset) || type == typeof(DateOnly)
            || type == typeof(TimeOnly) => 8,
        _ when type == typeof(Guid) || type == typeof(decimal) || type == typeof(TimeSpan) => 16,
        _ when type == typeof(string) => NominalTextBytes,
        _ when type == typeof(byte[]) => NominalBinaryBytes,
        _ => NominalOtherBytes,
    };

    public static long Scalar(object? value) => value switch
    {
        null or DBNull => 0,
        string s => RowHeaderBytes + FieldHeaderBytes + System.Text.Encoding.UTF8.GetByteCount(s),
        byte[] b => RowHeaderBytes + FieldHeaderBytes + b.Length,
        _ => RowHeaderBytes + FieldHeaderBytes + FieldBytes(value.GetType()),
    };
}
