using System.Collections.Immutable;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Runtime;

/// <summary>
/// Runs every Power mutation (telemetry ingest and administrator commands).
///
/// Cached reads OFF (the default): legacy. No serialization; framework state
/// changes are applied to <see cref="LoadSheddingStateStore"/> immediately,
/// exactly where the handlers applied them before, and nothing is staged.
///
/// Cached reads ON:
/// 1. The mutation waits for the store's write gate (one mutation at a time,
///    hydration included) and captures the published snapshot.
/// 2. The handler works on detached candidate state: tracked EF entities for
///    durable fields, and <see cref="PowerMutation.Framework"/> for the
///    framework. Nothing it does is visible to readers.
/// 3. After <c>SaveChangesAsync</c> returns, the handler calls
///    <see cref="PowerMutation.MarkCommitted"/>. When the handler returns, the
///    coordinator builds the next snapshot from the captured snapshot plus the
///    staged committed values and publishes it, then publishes the framework
///    state. No database reload.
/// 4. If SaveChanges throws (or the handler returns without committing),
///    nothing is published: the snapshot and framework state stay as captured.
///
/// Extension points for later slices: <see cref="PowerMutation.Captured"/>
/// (immutable capture), <see cref="ExecuteAsync{T}"/> (serialized candidate
/// mutation), <see cref="PowerMutation.MarkCommitted"/> (post-commit
/// publication), <see cref="PowerMutation.StageEvent"/> (event insertion) and
/// <see cref="PowerMutation.MarkLiveOnly"/> (live-only publication).
/// </summary>
public sealed class PowerMutationCoordinator
{
    private readonly LoadSheddingStateStore _framework;
    private readonly IPowerRuntimeStore? _store;
    private readonly TimeProvider _timeProvider;

    public PowerMutationCoordinator(LoadSheddingStateStore framework, IPowerRuntimeStore store, TimeProvider timeProvider)
    {
        _framework = framework;
        _store = store;
        _timeProvider = timeProvider;
    }

    private PowerMutationCoordinator(LoadSheddingStateStore framework)
    {
        _framework = framework;
        _timeProvider = TimeProvider.System;
    }

    /// <summary>The legacy, unserialized coordinator the pre-runtime handler constructors use.</summary>
    public static PowerMutationCoordinator Legacy(LoadSheddingStateStore framework) => new(framework);

    /// <summary>True when cached reads are on and mutations are serialized and published post-commit.</summary>
    public bool Serialized => _store is { Enabled: true };

    public async Task<T> ExecuteAsync<T>(Func<PowerMutation, Task<T>> body, CancellationToken cancellationToken)
    {
        if (!Serialized)
        {
            return await body(PowerMutation.ForLegacy(_framework));
        }

        using var gate = await _store!.EnterWriteAsync(cancellationToken);
        var captured = await gate.CaptureAsync(cancellationToken);
        var mutation = PowerMutation.ForCandidate(captured);

        var result = await body(mutation);

        if (mutation.Publication is not PowerPublication.None)
        {
            var next = mutation.BuildNext(RuntimeTime.Normalize(_timeProvider.GetUtcNow()));
            gate.Publish(captured, next);
            if (mutation.Publication is PowerPublication.Committed)
            {
                _framework.Update(_ => next.Framework);
            }
        }

        return result;
    }
}

public enum PowerPublication
{
    None,
    LiveOnly,
    Committed,
}

/// <summary>
/// One mutation's candidate state. Created by <see cref="PowerMutationCoordinator"/>.
/// Entities passed to the Stage methods are copied when the mutation is
/// published (after SaveChanges, so database-generated ids and audit fields are
/// included), never earlier.
/// </summary>
public sealed class PowerMutation
{
    private readonly LoadSheddingStateStore? _legacyFramework;
    private readonly Dictionary<int, Outlet> _outlets = new();
    private readonly Dictionary<int, RuntimeRelayReport> _relayReports = new();
    private readonly List<PowerEvent> _events = new();
    private readonly List<TelemetryReading> _readings = new();
    private readonly List<InaReading> _ina = new();
    private PowerSystemConfig? _config;
    private LoadSheddingState _candidateFramework;

    private PowerMutation(PowerRuntimeSnapshot? captured, LoadSheddingStateStore? legacyFramework)
    {
        Captured = captured;
        _legacyFramework = legacyFramework;
        _candidateFramework = captured?.Framework ?? LoadSheddingState.Initial;
    }

    internal static PowerMutation ForLegacy(LoadSheddingStateStore framework) => new(null, framework);

    internal static PowerMutation ForCandidate(PowerRuntimeSnapshot captured) => new(captured, null);

    /// <summary>The snapshot this mutation started from; null on the legacy path.</summary>
    public PowerRuntimeSnapshot? Captured { get; }

    /// <summary>True on the legacy path: framework writes are immediate and nothing is staged.</summary>
    public bool IsLegacy => _legacyFramework is not null;

    public PowerPublication Publication { get; private set; }

    /// <summary>Framework state as this mutation sees it (live store on the legacy path; candidate otherwise).</summary>
    public LoadSheddingState Framework => _legacyFramework?.Current ?? _candidateFramework;

    /// <summary>Applies a framework change. Legacy: immediately to the store. Otherwise: to the candidate only.</summary>
    public LoadSheddingState UpdateFramework(Func<LoadSheddingState, LoadSheddingState> mutate)
    {
        if (_legacyFramework is not null)
        {
            return _legacyFramework.Update(mutate);
        }

        _candidateFramework = mutate(_candidateFramework);
        return _candidateFramework;
    }

    public void StageConfig(PowerSystemConfig config)
    {
        if (!IsLegacy) _config = config;
    }

    public void StageOutlet(Outlet outlet)
    {
        if (!IsLegacy) _outlets[outlet.Id] = outlet;
    }

    public void StageOutlets(IEnumerable<Outlet> outlets)
    {
        foreach (var outlet in outlets) StageOutlet(outlet);
    }

    /// <summary>Records what the device reported. Never treated as an acknowledgement.</summary>
    public void StageRelayReport(int outletId, bool relayClosed, Guid? commandId, DateTimeOffset reportedAtUtc)
    {
        if (!IsLegacy) _relayReports[outletId] = new RuntimeRelayReport(relayClosed, commandId, RuntimeTime.Normalize(reportedAtUtc));
    }

    public void StageEvent(PowerEvent powerEvent)
    {
        if (!IsLegacy) _events.Add(powerEvent);
    }

    public void StageReading(TelemetryReading reading)
    {
        if (!IsLegacy) _readings.Add(reading);
    }

    public void StageIna(InaReading reading)
    {
        if (!IsLegacy) _ina.Add(reading);
    }

    /// <summary>Call immediately after SaveChanges succeeds. Everything staged is published.</summary>
    public void MarkCommitted() => Publication = PowerPublication.Committed;

    /// <summary>
    /// Publishes only live measurements (outlet <c>CurrentWatts</c>/<c>LastSeen</c>,
    /// voltage samples, INA226 sample) without a durable commit. Staged
    /// configuration, events, command/recovery fields and framework changes
    /// are NOT published. Not used by D; reserved for runtime ingest.
    /// </summary>
    public void MarkLiveOnly()
    {
        if (Publication is PowerPublication.None) Publication = PowerPublication.LiveOnly;
    }

    internal PowerRuntimeSnapshot BuildNext(DateTimeOffset now)
    {
        var captured = Captured!;
        var committed = Publication is PowerPublication.Committed;

        // Id 0 means the handler fell back to an unsaved `new PowerSystemConfig()`
        // because no row exists; that object was never committed.
        var config = committed && _config is { Id: > 0 } ? RuntimeConfig.From(_config) : captured.Config;

        var outlets = captured.Outlets.ToDictionary(o => o.Id);
        foreach (var (id, entity) in _outlets)
        {
            var report = _relayReports.TryGetValue(id, out var r) ? r : outlets.GetValueOrDefault(id)?.LastRelayReport;
            if (committed)
            {
                outlets[id] = RuntimeOutlet.From(entity, report);
            }
            else if (outlets.TryGetValue(id, out var existing))
            {
                outlets[id] = existing with
                {
                    CurrentWatts = entity.CurrentWatts,
                    LastSeen = RuntimeTime.Normalize(entity.LastSeen),
                    LastRelayReport = report,
                };
            }
        }

        foreach (var (id, report) in _relayReports)
        {
            if (!_outlets.ContainsKey(id) && outlets.TryGetValue(id, out var existing))
            {
                outlets[id] = existing with { LastRelayReport = report };
            }
        }

        var orderedOutlets = outlets.Values.OrderBy(o => o.Id).ToImmutableArray();

        var events = committed
            ? PowerRuntimeSnapshot.OrderEvents(captured.RecentEvents.Concat(_events.Select(RuntimeEvent.From)))
            : captured.RecentEvents;

        var latestIna = captured.LatestIna;
        foreach (var sample in _ina.Select(RuntimeInaSample.From))
        {
            if (latestIna is null || sample.Timestamp >= latestIna.Timestamp)
            {
                latestIna = sample;
            }
        }

        var voltage = captured.VoltageWindow.Append(
            _readings.Select(r => new RuntimeVoltageSample(r.OutletId, RuntimeTime.Normalize(r.Timestamp), r.Voltage)),
            now);

        var configChanged = committed
            && ((config is not null && config.ConfigurationDiffers(captured.Config))
                || orderedOutlets.Length != captured.Outlets.Length
                || orderedOutlets.Zip(captured.Outlets).Any(pair => pair.First.Id != pair.Second.Id || pair.First.PolicyDiffers(pair.Second)));

        return captured with
        {
            ConfigVersion = captured.ConfigVersion + (configChanged ? 1 : 0),
            LiveVersion = captured.LiveVersion + 1,
            Config = config,
            Outlets = orderedOutlets,
            Framework = committed ? _candidateFramework : captured.Framework,
            RecentEvents = events,
            LatestIna = latestIna,
            VoltageWindow = voltage,
        };
    }
}
