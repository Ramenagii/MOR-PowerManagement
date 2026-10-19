namespace Mor.PowerManagement.Application.Power.Runtime;

/// <summary>
/// Holds the published <see cref="PowerRuntimeSnapshot"/> and the single write
/// gate every Power mutation and the hydration run under.
///
/// Readers take <see cref="GetAsync"/>: it returns the published snapshot, or
/// joins the single in-flight hydration when none is published yet. A failed
/// hydration publishes nothing and throws
/// <see cref="PowerRuntimeUnavailableException"/>; no default state is ever
/// served as if it were synchronized.
///
/// Only <see cref="PowerMutationCoordinator"/> publishes, and only while it
/// holds the write gate.
/// </summary>
public interface IPowerRuntimeStore
{
    /// <summary><c>Telemetry:CachedReadsEnabled</c>.</summary>
    bool Enabled { get; }

    /// <summary>The published snapshot, or null before hydration.</summary>
    PowerRuntimeSnapshot? Published { get; }

    /// <summary>How many hydrations have run (successful or not). Diagnostic.</summary>
    int HydrationCount { get; }

    /// <summary>Published snapshot, hydrating once (single-flight) if needed.</summary>
    Task<PowerRuntimeSnapshot> GetAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Waits for exclusive write access. Hydration and every mutation hold this
    /// gate; reads never do.
    /// </summary>
    Task<PowerRuntimeWriteGate> EnterWriteAsync(CancellationToken cancellationToken = default);
}

/// <summary>Exclusive write access to the runtime store. Dispose to release.</summary>
public sealed class PowerRuntimeWriteGate : IDisposable
{
    private readonly PowerRuntimeStore _store;
    private int _released;

    internal PowerRuntimeWriteGate(PowerRuntimeStore store) => _store = store;

    /// <summary>The published snapshot, hydrating under this gate first if needed.</summary>
    public Task<PowerRuntimeSnapshot> CaptureAsync(CancellationToken cancellationToken = default)
        => _store.CaptureUnderGateAsync(this, cancellationToken);

    /// <summary>Publishes <paramref name="next"/>; <paramref name="expected"/> must still be current.</summary>
    public void Publish(PowerRuntimeSnapshot expected, PowerRuntimeSnapshot next)
        => _store.PublishUnderGate(this, expected, next);

    internal bool IsHeld => Volatile.Read(ref _released) == 0;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) == 0)
        {
            _store.ReleaseGate();
        }
    }
}

/// <summary>
/// Loads the durable parts of the snapshot from the database. Implemented in
/// Infrastructure. The framework state is not stored in the database; the
/// store attaches the in-memory framework state itself.
/// </summary>
public interface IPowerRuntimeHydrator
{
    Task<PowerRuntimeSnapshot> LoadAsync(CancellationToken cancellationToken);
}

/// <summary>The runtime snapshot is disabled, not yet hydrated, or hydration failed.</summary>
public sealed class PowerRuntimeUnavailableException : Exception
{
    public PowerRuntimeUnavailableException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }
}
