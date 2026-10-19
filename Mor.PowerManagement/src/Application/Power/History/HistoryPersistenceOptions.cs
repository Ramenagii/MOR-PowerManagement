using Microsoft.Extensions.Configuration;
using Mor.PowerManagement.Application.Power.Runtime;

namespace Mor.PowerManagement.Application.Power.History;

/// <summary>
/// PLAN-0001 Spec E settings. Both flags default OFF, including when the key
/// is absent. Valid combinations:
///
/// | CachedReads | RuntimeIngest | BatchPersistence | Path |
/// |-------------|---------------|------------------|------|
/// | any         | false         | false            | legacy ingest |
/// | true        | true          | false            | runtime ingest, synchronous history writes (rehearsal stage) |
/// | true        | true          | true             | runtime ingest, bounded buffer, batched history writes |
///
/// Everything else is rejected at startup by <see cref="Validate"/>.
/// </summary>
public sealed class HistoryPersistenceOptions
{
    public const string RuntimeIngestEnabledKey = "Telemetry:RuntimeIngestEnabled";

    public const string BatchPersistenceEnabledKey = "Telemetry:BatchPersistenceEnabled";

    /// <summary>Optional tuning keys live under this section (e.g. <c>Telemetry:History:FlushIntervalSeconds</c>).</summary>
    public const string TuningSection = "Telemetry:History";

    public bool RuntimeIngestEnabled { get; set; }

    public bool BatchPersistenceEnabled { get; set; }

    /// <summary>Normal loss bound and flush cadence: the oldest uncommitted acquisition is never meant to be older than this.</summary>
    public int FlushIntervalSeconds { get; set; } = 900;

    /// <summary>
    /// A scheduled flush starts when the oldest buffered acquisition is this
    /// much younger than <see cref="FlushIntervalSeconds"/>, so a normal flush
    /// commits before the loss bound is reached. Exposure is still measured
    /// including in-flight time; exceeding the bound is reported as a breach.
    /// </summary>
    public int FlushLeadSeconds { get; set; } = 30;

    /// <summary>A partial batch is flushed after this long without an accepted acquisition.</summary>
    public int InactivityFlushSeconds { get; set; } = 30;

    /// <summary>Active plus in-flight acquisitions.</summary>
    public int MaxBufferedAcquisitions { get; set; } = 1_800;

    /// <summary>Active plus in-flight measurement rows, including the INA226 row and the monitor mirror.</summary>
    public int MaxBufferedRows { get; set; } = 30_000;

    /// <summary>Accounted allocation of active plus in-flight acquisitions (conservative estimate including bookkeeping).</summary>
    public long MaxBufferedBytes { get; set; } = 32L * 1024 * 1024;

    /// <summary>Acquisitions per bulk transaction.</summary>
    public int MaxAcquisitionsPerBatch { get; set; } = 900;

    /// <summary>Graceful shutdown flush deadline, independent of the host's stopping token.</summary>
    public int ShutdownFlushSeconds { get; set; } = 30;

    /// <summary>Committed acquisitions kept in memory to bridge a cached durable chart prefix to the live tail.</summary>
    public int BridgeMaxAcquisitions { get; set; } = 1_800;

    /// <summary>First wait before a failed flush is retried with the same batch identity; doubles up to <see cref="RetryMaxSeconds"/>.</summary>
    public int RetryInitialSeconds { get; set; } = 30;

    public int RetryMaxSeconds { get; set; } = 300;

    /// <summary>Request bounds on the runtime-ingest path, checked before anything is buffered.</summary>
    public int MaxOutletSamples { get; set; } = 13;

    public int MaxRelayReports { get; set; } = 13;

    public int MaxRequestBodyBytes { get; set; } = 64 * 1024;

    public TimeSpan FlushInterval => TimeSpan.FromSeconds(FlushIntervalSeconds);

    public static HistoryPersistenceOptions FromConfiguration(IConfiguration configuration)
    {
        var options = new HistoryPersistenceOptions();
        configuration.GetSection(TuningSection).Bind(options);
        options.RuntimeIngestEnabled = configuration.GetValue<bool>(RuntimeIngestEnabledKey);
        options.BatchPersistenceEnabled = configuration.GetValue<bool>(BatchPersistenceEnabledKey);
        return options;
    }

    /// <summary>Throws when the flags form an unsupported combination or a bound is not positive.</summary>
    public void Validate(PowerRuntimeOptions runtime)
    {
        if (RuntimeIngestEnabled && !runtime.CachedReadsEnabled)
        {
            throw new InvalidOperationException(
                $"{RuntimeIngestEnabledKey}=true requires {PowerRuntimeOptions.CachedReadsEnabledKey}=true.");
        }

        if (BatchPersistenceEnabled && !(RuntimeIngestEnabled && runtime.CachedReadsEnabled))
        {
            throw new InvalidOperationException(
                $"{BatchPersistenceEnabledKey}=true requires {PowerRuntimeOptions.CachedReadsEnabledKey}=true and {RuntimeIngestEnabledKey}=true.");
        }

        if (FlushIntervalSeconds <= 0 || FlushLeadSeconds < 0 || FlushLeadSeconds >= FlushIntervalSeconds
            || InactivityFlushSeconds <= 0 || MaxBufferedAcquisitions <= 0 || MaxBufferedRows <= 0
            || MaxBufferedBytes <= 0 || MaxAcquisitionsPerBatch <= 0 || ShutdownFlushSeconds <= 0
            || BridgeMaxAcquisitions < 0 || RetryInitialSeconds <= 0 || RetryMaxSeconds < RetryInitialSeconds
            || MaxOutletSamples <= 0 || MaxRelayReports <= 0 || MaxRequestBodyBytes <= 0)
        {
            throw new InvalidOperationException($"{TuningSection} contains a non-positive or inconsistent bound.");
        }
    }
}
