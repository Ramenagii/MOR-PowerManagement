using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.Services;

namespace Mor.PowerManagement.Application.Power.Runtime;

/// <summary>
/// Single-process holder of the published runtime snapshot.
///
/// Lock boundaries:
/// - <c>_writeGate</c> (async, one holder): hydration and every Power mutation.
///   A mutation holds it across its database reads, SaveChanges and the
///   publication, so mutations are applied and published in one total order.
/// - <c>_gate</c> (monitor): only guards the single-flight hydration task
///   field. Nothing awaits while holding it.
/// - Reads take no lock: the published reference is swapped atomically and the
///   snapshot itself is immutable.
///
/// There is no timer and no refresh. The snapshot changes only by hydration
/// (once per process, or again on demand after a failed hydration) and by
/// post-commit publication.
/// </summary>
public sealed class PowerRuntimeStore : IPowerRuntimeStore
{
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly object _gate = new();
    private readonly IPowerRuntimeHydrator? _hydrator;
    private readonly LoadSheddingStateStore _framework;
    private PowerRuntimeSnapshot? _published;
    private Task<PowerRuntimeSnapshot>? _hydration;
    private int _hydrationCount;

    public PowerRuntimeStore(
        IOptions<PowerRuntimeOptions> options,
        LoadSheddingStateStore framework,
        IEnumerable<IPowerRuntimeHydrator> hydrators)
        : this(options.Value.CachedReadsEnabled, framework, hydrators.SingleOrDefault())
    {
    }

    public PowerRuntimeStore(bool enabled, LoadSheddingStateStore framework, IPowerRuntimeHydrator? hydrator)
    {
        Enabled = enabled;
        _framework = framework;
        _hydrator = hydrator;
    }

    public bool Enabled { get; }

    public PowerRuntimeSnapshot? Published => Volatile.Read(ref _published);

    public int HydrationCount => Volatile.Read(ref _hydrationCount);

    public Task<PowerRuntimeSnapshot> GetAsync(CancellationToken cancellationToken = default)
    {
        if (Published is { } published)
        {
            return Task.FromResult(published);
        }

        EnsureEnabled();

        Task<PowerRuntimeSnapshot> hydration;
        lock (_gate)
        {
            // Single-flight: every concurrent first reader awaits the same task.
            // It runs without the caller's token so one cancelled request
            // cannot fail hydration for the others. Task.Run keeps a hydrator
            // that completes synchronously from clearing _hydration before
            // this assignment has happened.
            hydration = _hydration ??= Task.Run(HydrateUnderNewGateAsync);
        }

        return hydration.WaitAsync(cancellationToken);
    }

    public async Task<PowerRuntimeWriteGate> EnterWriteAsync(CancellationToken cancellationToken = default)
    {
        EnsureEnabled();
        await _writeGate.WaitAsync(cancellationToken);
        return new PowerRuntimeWriteGate(this);
    }

    internal async Task<PowerRuntimeSnapshot> CaptureUnderGateAsync(PowerRuntimeWriteGate gate, CancellationToken cancellationToken)
    {
        EnsureHeld(gate);
        return Published ?? await HydrateHoldingGateAsync(cancellationToken);
    }

    internal void PublishUnderGate(PowerRuntimeWriteGate gate, PowerRuntimeSnapshot expected, PowerRuntimeSnapshot next)
    {
        EnsureHeld(gate);
        if (!ReferenceEquals(Published, expected))
        {
            // Unreachable while every writer holds the gate; refuse rather than
            // silently overwrite a publication this mutation did not start from.
            throw new InvalidOperationException("The runtime snapshot changed during a serialized mutation.");
        }

        Volatile.Write(ref _published, next);
    }

    internal void ReleaseGate() => _writeGate.Release();

    private async Task<PowerRuntimeSnapshot> HydrateUnderNewGateAsync()
    {
        try
        {
            await _writeGate.WaitAsync(CancellationToken.None);
            try
            {
                // A mutation may have hydrated while this task waited for the gate.
                return Published ?? await HydrateHoldingGateAsync(CancellationToken.None);
            }
            finally
            {
                _writeGate.Release();
            }
        }
        finally
        {
            lock (_gate)
            {
                // Success leaves Published set; failure clears the task so a
                // later request may try again (on demand, never on a timer).
                _hydration = null;
            }
        }
    }

    private async Task<PowerRuntimeSnapshot> HydrateHoldingGateAsync(CancellationToken cancellationToken)
    {
        if (_hydrator is null)
        {
            throw new PowerRuntimeUnavailableException("Cached reads are enabled but no runtime hydrator is registered.");
        }

        Interlocked.Increment(ref _hydrationCount);
        PowerRuntimeSnapshot loaded;
        try
        {
            loaded = await _hydrator.LoadAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            throw new PowerRuntimeUnavailableException(
                $"Runtime hydration failed ({ex.GetType().Name}); runtime reads stay unavailable until a hydration succeeds.", ex);
        }

        var hydrated = loaded with
        {
            ConfigVersion = 1,
            LiveVersion = 1,
            Framework = _framework.Current,
        };
        Volatile.Write(ref _published, hydrated);
        return hydrated;
    }

    private void EnsureEnabled()
    {
        if (!Enabled)
        {
            throw new PowerRuntimeUnavailableException("Telemetry:CachedReadsEnabled is off; the runtime snapshot is not used.");
        }
    }

    private static void EnsureHeld(PowerRuntimeWriteGate gate)
    {
        if (!gate.IsHeld)
        {
            throw new InvalidOperationException("The runtime write gate has already been released.");
        }
    }
}
