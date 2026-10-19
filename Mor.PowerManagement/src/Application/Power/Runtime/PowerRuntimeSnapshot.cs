using System.Collections.Immutable;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Runtime;

/// <summary>
/// One immutable, versioned view of the rig: configuration, roster, live
/// outlet/command state, framework state, recent events, the latest INA226
/// sample and the mains-voltage window.
///
/// It holds copies only. No tracked entity, DbContext or scope is retained, so
/// a captured snapshot never changes underneath a reader. A new snapshot is
/// built for every publication.
///
/// <see cref="ConfigVersion"/> advances only when configuration or roster
/// policy changes; <see cref="LiveVersion"/> advances on every publication.
/// </summary>
public sealed record PowerRuntimeSnapshot
{
    /// <summary>The dashboard shows the latest 20 events; ingest needs only the latest one.</summary>
    public const int RecentEventCapacity = 20;

    public long ConfigVersion { get; init; }

    public long LiveVersion { get; init; }

    public DateTimeOffset HydratedAtUtc { get; init; }

    /// <summary>Null when no configuration row exists (legacy readers then use entity defaults).</summary>
    public RuntimeConfig? Config { get; init; }

    /// <summary>Every outlet, ordered by id.</summary>
    public ImmutableArray<RuntimeOutlet> Outlets { get; init; } = ImmutableArray<RuntimeOutlet>.Empty;

    /// <summary>The load-shedding framework's cross-batch state, as last published.</summary>
    public LoadSheddingState Framework { get; init; } = LoadSheddingState.Initial;

    /// <summary>Newest first (timestamp, then id), at most <see cref="RecentEventCapacity"/>.</summary>
    public ImmutableArray<RuntimeEvent> RecentEvents { get; init; } = ImmutableArray<RuntimeEvent>.Empty;

    /// <summary>The newest stored INA226 sample of any age; freshness is decided per projection.</summary>
    public RuntimeInaSample? LatestIna { get; init; }

    public RuntimeVoltageWindow VoltageWindow { get; init; } = RuntimeVoltageWindow.Empty;

    /// <summary>The configuration readers use: the stored row, or the entity defaults when there is none.</summary>
    public RuntimeConfig EffectiveConfig => Config ?? RuntimeConfig.Defaults;

    /// <summary>The latest event of any kind (ingest's warning de-duplication reads this one).</summary>
    public RuntimeEvent? LatestEvent => RecentEvents.IsDefaultOrEmpty ? null : RecentEvents[0];

    public static ImmutableArray<RuntimeEvent> OrderEvents(IEnumerable<RuntimeEvent> events)
        => events
            .OrderByDescending(e => e.Timestamp)
            .ThenByDescending(e => e.Id)
            .Take(RecentEventCapacity)
            .ToImmutableArray();
}

/// <summary>
/// PostgreSQL <c>timestamptz</c> keeps microseconds and Npgsql truncates the
/// rest when writing. Snapshot copies are normalized the same way, so a
/// published value equals what a database reload would return.
/// </summary>
public static class RuntimeTime
{
    public static DateTimeOffset Normalize(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(utc.Ticks - (utc.Ticks % 10), TimeSpan.Zero);
    }

    public static DateTimeOffset? Normalize(DateTimeOffset? value)
        => value.HasValue ? Normalize(value.Value) : null;
}

public sealed record RuntimeConfig(
    int Id,
    double MaxCapacityWatts,
    double WarningThresholdWatts,
    double CriticalThresholdWatts,
    double StandbyThresholdWatts,
    int StandbyIdleMinutes,
    int StabilizationDelayMs,
    bool AutomaticPrioritisationEnabled,
    Guid? LastAcquisitionSessionId,
    long LastAcquisitionSequence,
    MeteringMode MeteringMode,
    DateTimeOffset? MeteringModeUpdatedAt,
    double ZmctCtRatio,
    double ZmctBurdenOhms,
    double ZmctPowerFactor,
    double ZmctGain)
{
    /// <summary>The values legacy readers fall back to (<c>?? new PowerSystemConfig()</c>).</summary>
    public static RuntimeConfig Defaults { get; } = From(new PowerSystemConfig());

    public static RuntimeConfig From(PowerSystemConfig c) => new(
        c.Id,
        c.MaxCapacityWatts,
        c.WarningThresholdWatts,
        c.CriticalThresholdWatts,
        c.StandbyThresholdWatts,
        c.StandbyIdleMinutes,
        c.StabilizationDelayMs,
        c.AutomaticPrioritisationEnabled,
        c.LastAcquisitionSessionId,
        c.LastAcquisitionSequence,
        c.MeteringMode,
        RuntimeTime.Normalize(c.MeteringModeUpdatedAt),
        c.ZmctCtRatio,
        c.ZmctBurdenOhms,
        c.ZmctPowerFactor,
        c.ZmctGain);

    /// <summary>
    /// A detached entity carrying exactly these values (runtime ingest
    /// evaluates on it and attaches it unchanged, so no query is needed).
    /// Audit fields are not part of the snapshot and stay default; they are
    /// never marked modified by an attach.
    /// </summary>
    public PowerSystemConfig ToEntity() => new()
    {
        Id = Id,
        MaxCapacityWatts = MaxCapacityWatts,
        WarningThresholdWatts = WarningThresholdWatts,
        CriticalThresholdWatts = CriticalThresholdWatts,
        StandbyThresholdWatts = StandbyThresholdWatts,
        StandbyIdleMinutes = StandbyIdleMinutes,
        StabilizationDelayMs = StabilizationDelayMs,
        AutomaticPrioritisationEnabled = AutomaticPrioritisationEnabled,
        LastAcquisitionSessionId = LastAcquisitionSessionId,
        LastAcquisitionSequence = LastAcquisitionSequence,
        MeteringMode = MeteringMode,
        MeteringModeUpdatedAt = MeteringModeUpdatedAt,
        ZmctCtRatio = ZmctCtRatio,
        ZmctBurdenOhms = ZmctBurdenOhms,
        ZmctPowerFactor = ZmctPowerFactor,
        ZmctGain = ZmctGain,
    };

    /// <summary>True when the device-facing configuration (thresholds, calibration) differs.</summary>
    public bool ConfigurationDiffers(RuntimeConfig? other)
        => other is null
            || MaxCapacityWatts != other.MaxCapacityWatts
            || WarningThresholdWatts != other.WarningThresholdWatts
            || CriticalThresholdWatts != other.CriticalThresholdWatts
            || StandbyThresholdWatts != other.StandbyThresholdWatts
            || StandbyIdleMinutes != other.StandbyIdleMinutes
            || StabilizationDelayMs != other.StabilizationDelayMs
            || AutomaticPrioritisationEnabled != other.AutomaticPrioritisationEnabled
            || ZmctCtRatio != other.ZmctCtRatio
            || ZmctBurdenOhms != other.ZmctBurdenOhms
            || ZmctPowerFactor != other.ZmctPowerFactor
            || ZmctGain != other.ZmctGain;
}

/// <summary>
/// The last relay-state report the device sent for an outlet. Kept apart from
/// the acknowledgement fields on <see cref="RuntimeOutlet"/>: a report is what
/// the device said; an acknowledgement exists only when the report matched the
/// pending command id AND relay state under the existing ingest rule.
/// Not persisted, so it is null after hydration.
/// </summary>
public sealed record RuntimeRelayReport(bool RelayClosed, Guid? CommandId, DateTimeOffset ReportedAtUtc);

public sealed record RuntimeOutlet(
    int Id,
    string Name,
    string Role,
    string MeterChannel,
    string RelayChannel,
    int RatedVoltageVolts,
    OutletPriority Priority,
    bool IsProtected,
    double AllowanceWatts,
    string Schedule,
    int? IdleLimitMinutes,
    OutletStatus Status,
    DateTimeOffset? CommandedAtUtc,
    double CurrentWatts,
    DateTimeOffset? LastSeen,
    bool ManualHold,
    bool FaultHold,
    bool RecoveryLockout,
    int AutomaticRecoveryAttempts,
    Guid? RecoveryEpisodeId,
    DateTimeOffset? NextRecoveryAtUtc,
    bool RecoveryTrialPending,
    int RecoveryTrialOverLimitBatches,
    Guid? PendingCommandId,
    bool? PendingRelayClosed,
    string? PendingCommandOrigin,
    DateTimeOffset? PendingCommandIssuedAtUtc,
    DateTimeOffset? PendingCommandAcknowledgedAtUtc,
    bool CommandNeedsReview,
    RuntimeRelayReport? LastRelayReport = null)
{
    public static RuntimeOutlet From(Outlet o, RuntimeRelayReport? lastRelayReport = null) => new(
        o.Id,
        o.Name,
        o.Role,
        o.MeterChannel,
        o.RelayChannel,
        o.RatedVoltageVolts,
        o.Priority,
        o.IsProtected,
        o.AllowanceWatts,
        o.Schedule,
        o.IdleLimitMinutes,
        o.Status,
        RuntimeTime.Normalize(o.CommandedAtUtc),
        o.CurrentWatts,
        RuntimeTime.Normalize(o.LastSeen),
        o.ManualHold,
        o.FaultHold,
        o.RecoveryLockout,
        o.AutomaticRecoveryAttempts,
        o.RecoveryEpisodeId,
        RuntimeTime.Normalize(o.NextRecoveryAtUtc),
        o.RecoveryTrialPending,
        o.RecoveryTrialOverLimitBatches,
        o.PendingCommandId,
        o.PendingRelayClosed,
        o.PendingCommandOrigin,
        RuntimeTime.Normalize(o.PendingCommandIssuedAtUtc),
        RuntimeTime.Normalize(o.PendingCommandAcknowledgedAtUtc),
        o.CommandNeedsReview,
        lastRelayReport);

    /// <summary>A detached entity carrying exactly these values (see <see cref="RuntimeConfig.ToEntity"/>).</summary>
    public Outlet ToEntity() => new()
    {
        Id = Id,
        Name = Name,
        Role = Role,
        MeterChannel = MeterChannel,
        RelayChannel = RelayChannel,
        RatedVoltageVolts = RatedVoltageVolts,
        Priority = Priority,
        IsProtected = IsProtected,
        AllowanceWatts = AllowanceWatts,
        Schedule = Schedule,
        IdleLimitMinutes = IdleLimitMinutes,
        Status = Status,
        CommandedAtUtc = CommandedAtUtc,
        CurrentWatts = CurrentWatts,
        LastSeen = LastSeen,
        ManualHold = ManualHold,
        FaultHold = FaultHold,
        RecoveryLockout = RecoveryLockout,
        AutomaticRecoveryAttempts = AutomaticRecoveryAttempts,
        RecoveryEpisodeId = RecoveryEpisodeId,
        NextRecoveryAtUtc = NextRecoveryAtUtc,
        RecoveryTrialPending = RecoveryTrialPending,
        RecoveryTrialOverLimitBatches = RecoveryTrialOverLimitBatches,
        PendingCommandId = PendingCommandId,
        PendingRelayClosed = PendingRelayClosed,
        PendingCommandOrigin = PendingCommandOrigin,
        PendingCommandIssuedAtUtc = PendingCommandIssuedAtUtc,
        PendingCommandAcknowledgedAtUtc = PendingCommandAcknowledgedAtUtc,
        CommandNeedsReview = CommandNeedsReview,
    };

    public OutletLoadSnapshot ToLoadSnapshot()
        => new(Id, Priority, Status, CurrentWatts, AllowanceWatts, LastSeen, Name, IsProtected, ManualHold, RecoveryLockout, AutomaticRecoveryAttempts);

    /// <summary>True when roster/policy fields the device or dashboard configure differ.</summary>
    public bool PolicyDiffers(RuntimeOutlet other)
        => Name != other.Name
            || Role != other.Role
            || MeterChannel != other.MeterChannel
            || RelayChannel != other.RelayChannel
            || RatedVoltageVolts != other.RatedVoltageVolts
            || Priority != other.Priority
            || IsProtected != other.IsProtected
            || AllowanceWatts != other.AllowanceWatts
            || Schedule != other.Schedule
            || IdleLimitMinutes != other.IdleLimitMinutes;
}

public sealed record RuntimeEvent(
    int Id,
    DateTimeOffset Timestamp,
    string Title,
    string Detail,
    EventSeverity Severity,
    string? Actor)
{
    public static RuntimeEvent From(PowerEvent e)
        => new(e.Id, RuntimeTime.Normalize(e.Timestamp), e.Title, e.Detail, e.Severity, e.CreatedBy);
}

public sealed record RuntimeInaSample(
    double? BusVoltageV,
    double? ShuntVoltageMv,
    double? CurrentA,
    double? PowerW,
    DateTimeOffset Timestamp)
{
    public static RuntimeInaSample From(InaReading r)
        => new(r.BusVoltageV, r.ShuntVoltageMv, r.CurrentA, r.PowerW, RuntimeTime.Normalize(r.Timestamp));
}

public readonly record struct RuntimeVoltageSample(int OutletId, DateTimeOffset Timestamp, double Voltage);

/// <summary>
/// The stored telemetry samples the dashboard's mains-voltage figure can still
/// use. The legacy figure is
/// <c>AVG(Voltage) WHERE Timestamp &gt;= now - 30 s AND Voltage &gt; 0 AND OutletId IN (mains outlets)</c>,
/// evaluated against the clock at read time; <see cref="Average"/> computes the
/// same thing from memory.
///
/// Bounded twice: a sample older than <see cref="WindowSeconds"/> before the
/// publication clock can never satisfy a later cutoff and is dropped, and at
/// most <see cref="MaxSamples"/> samples are kept (oldest dropped first). The
/// count bound is about 40x the rig's steady rate (13 channels at 1 Hz over
/// 30 s is 390 samples); reaching it is reported through
/// <see cref="DroppedForCapacity"/>.
/// </summary>
public sealed record RuntimeVoltageWindow
{
    public const int WindowSeconds = 30;

    public const int MaxSamples = 16_384;

    public static RuntimeVoltageWindow Empty { get; } = new();

    public ImmutableArray<RuntimeVoltageSample> Samples { get; init; } = ImmutableArray<RuntimeVoltageSample>.Empty;

    /// <summary>Samples discarded by the count bound since hydration (diagnostic; 0 in normal operation).</summary>
    public long DroppedForCapacity { get; init; }

    public RuntimeVoltageWindow Append(IEnumerable<RuntimeVoltageSample> added, DateTimeOffset now)
    {
        var horizon = now.AddSeconds(-WindowSeconds);
        var kept = Samples
            .Concat(added.Where(s => s.Voltage > 0))
            .Where(s => s.Timestamp >= horizon)
            .ToList();
        var dropped = Math.Max(0, kept.Count - MaxSamples);
        return new RuntimeVoltageWindow
        {
            Samples = kept.Skip(dropped).ToImmutableArray(),
            DroppedForCapacity = DroppedForCapacity + dropped,
        };
    }

    /// <summary>Average of samples at or after <paramref name="cutoff"/> from the given outlets; null when none.</summary>
    public double? Average(DateTimeOffset cutoff, IReadOnlyCollection<int> outletIds)
    {
        double sum = 0;
        var count = 0;
        foreach (var sample in Samples)
        {
            if (sample.Timestamp >= cutoff && sample.Voltage > 0 && outletIds.Contains(sample.OutletId))
            {
                sum += sample.Voltage;
                count++;
            }
        }

        return count == 0 ? null : sum / count;
    }
}
