using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Power.History;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>
/// Seven-day raw retention (PLAN-0001 Spec F, approved revisions B and C).
/// Off by default; while off the legacy six-hour job keeps running unchanged.
/// The retention windows are fixed by the plan, not configuration: only batch
/// sizes are tunable.
/// </summary>
public sealed class RetentionV2Options
{
    public const string EnabledKey = "Telemetry:RetentionV2Enabled";

    public const string TuningSection = "Telemetry:RetentionV2";

    /// <summary>Legacy knobs. Ignored (and reported once) while V2 is on.</summary>
    public static readonly string[] LegacyOverrideKeys = ["Telemetry:RawRetentionHours", "Telemetry:RollupRetentionDays"];

    public static readonly TimeSpan RawRetention = TimeSpan.FromDays(7);

    /// <summary>Minute and five-minute summaries, and control/audit events, are kept through day 30.</summary>
    public static readonly TimeSpan SummaryRetention = TimeSpan.FromDays(30);

    /// <summary>The newest control/audit events are never age-deleted, however old.</summary>
    public const int RecentEventFloor = 20;

    public bool Enabled { get; set; }

    /// <summary>Raw rows consumed per compaction transaction.</summary>
    public int CompactionBatchRows { get; set; } = 50_000;

    /// <summary>Summary buckets or events deleted per prune statement.</summary>
    public int PruneBatchRows { get; set; } = 10_000;

    /// <summary>Ceiling on batches per step per maintenance window, so one window cannot monopolise the pool.</summary>
    public int MaxBatchesPerRun { get; set; } = 20;

    /// <summary>Legacy keys present in configuration; names only, never values.</summary>
    public IReadOnlyList<string> IgnoredLegacyKeys { get; set; } = [];

    public static RetentionV2Options FromConfiguration(IConfiguration configuration)
    {
        var options = new RetentionV2Options();
        configuration.GetSection(TuningSection).Bind(options);
        options.Enabled = configuration.GetValue<bool>(EnabledKey);
        options.IgnoredLegacyKeys = LegacyOverrideKeys.Where(k => configuration[k] is not null).ToArray();
        return options;
    }

    /// <summary>Throws when V2 is on without the runtime ingest and batch persistence it runs inside.</summary>
    public void Validate(IConfiguration configuration)
    {
        if (Enabled && !(configuration.GetValue<bool>(HistoryPersistenceOptions.RuntimeIngestEnabledKey)
                         && configuration.GetValue<bool>(HistoryPersistenceOptions.BatchPersistenceEnabledKey)))
        {
            throw new InvalidOperationException(
                $"{EnabledKey}=true requires {HistoryPersistenceOptions.RuntimeIngestEnabledKey}=true and {HistoryPersistenceOptions.BatchPersistenceEnabledKey}=true.");
        }

        if (CompactionBatchRows <= 0 || PruneBatchRows <= 0 || MaxBatchesPerRun <= 0)
        {
            throw new InvalidOperationException($"{TuningSection} contains a non-positive bound.");
        }
    }
}

public static class RetentionV2Registration
{
    /// <summary>
    /// With V2 on, swaps E's legacy maintenance job for <see cref="RetentionV2Maintenance"/>.
    /// It runs only inside E's maintenance windows; there is no timer of its own.
    /// </summary>
    public static IServiceCollection AddRetentionV2(this IServiceCollection services, IConfiguration configuration)
    {
        var options = RetentionV2Options.FromConfiguration(configuration);
        options.Validate(configuration);
        if (!options.Enabled) return services;

        var legacy = services.Where(d => d.ServiceType == typeof(IHistoryMaintenance)
                                         && d.ImplementationType == typeof(LegacyHistoryMaintenance)).ToList();
        foreach (var descriptor in legacy) services.Remove(descriptor);

        services.AddSingleton(options);
        services.AddSingleton<TelemetryCompactionRunner>();
        services.AddSingleton<ControlEventRetention>();
        services.AddSingleton<IHistoryMaintenance, RetentionV2Maintenance>();
        return services;
    }
}
