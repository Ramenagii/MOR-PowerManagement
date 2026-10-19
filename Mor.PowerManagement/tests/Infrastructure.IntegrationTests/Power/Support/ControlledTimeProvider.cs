namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

/// <summary>
/// A deterministic <see cref="TimeProvider"/> for PLAN-0001 characterization.
/// Time moves only when a test calls <see cref="Advance"/> or
/// <see cref="SetUtcNow"/>, so timer boundaries (3 s overload confirmation,
/// 6 s sample gap, 5 s acknowledgement deadline, 55 s recovery, 60 s relay
/// grace, 5 min warning repeat) are exercised exactly and without sleeping.
/// Always UTC: PostgreSQL timestamptz columns reject non-zero offsets.
/// Timers are deliberately unsupported; no characterized handler creates one.
/// </summary>
public sealed class ControlledTimeProvider : TimeProvider
{
    public static readonly DateTimeOffset DefaultStart = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private readonly object _gate = new();
    private DateTimeOffset _utcNow;
    private long _reads;

    public ControlledTimeProvider()
        : this(DefaultStart)
    {
    }

    public ControlledTimeProvider(DateTimeOffset start)
    {
        _utcNow = start.ToUniversalTime();
    }

    /// <summary>Number of <see cref="GetUtcNow"/> calls observed, for clock-read assertions.</summary>
    public long Reads
    {
        get
        {
            lock (_gate)
            {
                return _reads;
            }
        }
    }

    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate)
        {
            _reads++;
            return _utcNow;
        }
    }

    /// <summary>Current controlled time without counting it as a clock read.</summary>
    public DateTimeOffset Peek()
    {
        lock (_gate)
        {
            return _utcNow;
        }
    }

    public DateTimeOffset Advance(TimeSpan delta)
    {
        if (delta < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(delta), "Use SetUtcNow to move the clock backwards deliberately.");
        }

        lock (_gate)
        {
            _utcNow = _utcNow.Add(delta);
            return _utcNow;
        }
    }

    public DateTimeOffset AdvanceSeconds(double seconds) => Advance(TimeSpan.FromSeconds(seconds));

    /// <summary>Sets an absolute time; may move backwards to characterize out-of-order input.</summary>
    public void SetUtcNow(DateTimeOffset utcNow)
    {
        lock (_gate)
        {
            _utcNow = utcNow.ToUniversalTime();
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        => throw new NotSupportedException("ControlledTimeProvider does not run timers; advance the clock and invoke the work explicitly.");
}
