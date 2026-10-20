using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Infrastructure.Observability;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>Timers inspect memory only. Empty windows perform no database work.</summary>
public sealed class BatchWindowCoordinator(BoundedHistoryBuffer buffer, TelemetryBulkWriter writer,
    IEnumerable<IHistoryMaintenance> maintenance, IOptions<HistoryPersistenceOptions> options,
    TimeProvider clock, ILogger<BatchWindowCoordinator> logger, HistoryTailMerger merger) : BackgroundService
{
    private readonly SemaphoreSlim _flush = new(1);
    private readonly HistoryPersistenceOptions _options = options.Value;
    private DateTimeOffset _retryAt;

    public async Task InitializeAsync(CancellationToken token = default)
    {
        if (!buffer.Enabled) return;
        await writer.InitializeAsync(buffer, token);
        await Maintain(HistoryMaintenanceTrigger.Initialization, token);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!buffer.Enabled) return;
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), clock);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                _ = buffer.GetStatus(); // includes in-flight exposure in the loss-bound measurement
                if (buffer.IsDue() && clock.GetUtcNow() >= _retryAt) await FlushAsync("scheduled/inactivity", stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    public async Task<bool> FlushAsync(string trigger, CancellationToken token = default)
    {
        if (!buffer.Enabled) return true;
        await _flush.WaitAsync(token);
        try
        {
            var batch = buffer.BeginBatch();
            if (batch is null) return true;
            var started = clock.GetUtcNow();
            try
            {
                await writer.WriteAsync(batch, token);
                // Latch a loss-bound breach before removing the in-flight acquisitions.
                _ = buffer.GetStatus();
                buffer.Complete(batch, Record("committed", null));
            }
            catch (Exception ex)
            {
                // Never log payloads, SQL or exception messages (which can contain parameters).
                buffer.Failed(Record("failed", ex.GetType().Name));
                var failures = buffer.GetStatus().ConsecutiveFlushFailures;
                var seconds = Math.Min(_options.RetryMaxSeconds, _options.RetryInitialSeconds * Math.Pow(2, Math.Min(10, failures - 1)));
                _retryAt = clock.GetUtcNow().AddSeconds(seconds);
                logger.LogWarning("History flush failed ({ErrorType}); retry deferred, {Acquisitions} acquisitions retained.", ex.GetType().Name, batch.Acquisitions.Length);
                return false;
            }
            await Maintain(HistoryMaintenanceTrigger.FlushWindow, token);
            return true;

            HistoryFlushRecord Record(string outcome, string? error) => new(started, clock.GetUtcNow() - started,
                trigger, outcome, batch.Acquisitions.Length, batch.Acquisitions.Sum(a => a.RowCount), error);
        }
        finally { _flush.Release(); }
    }

    /// <summary>Drain successfully before switching flags/writers. Failure must stop the switch.</summary>
    public async Task<bool> DrainAsync(CancellationToken token = default)
    {
        while (buffer.GetStatus() is { BufferedRows: > 0 } or { ActiveAcquisitions: > 0 } or { InFlightAcquisitions: > 0 })
        {
            if (!await FlushAsync("drain", token)) return false;
        }
        return true;
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        if (!buffer.Enabled) { await base.StopAsync(cancellationToken); return; }
        var start = clock.GetUtcNow();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(_options.ShutdownFlushSeconds));
        var success = false;
        try
        {
            // Cancel the scheduling loop first; the flush semaphore coordinates any write already in progress.
            await base.StopAsync(deadline.Token);
            success = await DrainAsync(deadline.Token);
        }
        catch (OperationCanceledException) { }
        buffer.RecordShutdown(new(start, clock.GetUtcNow() - start, "shutdown", success ? "committed" : "failed",
            0, buffer.GetStatus().BufferedRows, success ? null : "Shutdown deadline or flush failure"));
    }

    private async Task Maintain(HistoryMaintenanceTrigger trigger, CancellationToken token)
    {
        using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.RetentionBulk);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        var window = new HistoryMaintenanceWindow(trigger, clock.GetUtcNow(), clock.GetUtcNow().AddSeconds(30));
        try
        {
            using var durableWindow = await merger.EnterDurableWindowAsync(deadline.Token);
            foreach (var job in maintenance)
            {
                try { await job.RunAsync(window, deadline.Token); }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { break; }
                catch (Exception ex) { logger.LogWarning("History maintenance {Name} failed ({ErrorType}).", job.Name, ex.GetType().Name); }
            }
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested)
        {
            // A busy prefix reader may consume the maintenance window before any job starts.
            // The committed batch stays successful and maintenance can run in a later window.
        }
    }
}
