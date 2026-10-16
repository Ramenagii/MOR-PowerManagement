using Mor.PowerManagement.Domain.Services;

namespace Mor.PowerManagement.Application.Power.Services;

/// <summary>
/// Holds the framework's cross-batch <see cref="LoadSheddingState"/>.
///
/// WHY IN MEMORY RATHER THAN A COLUMN: the state is a few counters and a shed
/// ledger - not rig configuration. It is rebuilt every time the process starts,
/// and losing it is safe by construction: a restart re-confirms the overload
/// over the confirmation period before shedding anything, and the ledger
/// coming back empty means the framework simply will not auto-restore, which
/// is the conservative direction. Persisting it would mean a migration and a
/// reconciliation story for state whose whole purpose is to be short-lived.
///
/// Manual override is deliberately NOT stored here alone: it is mirrored to a
/// PowerEvent when set so an operator's override survives a restart in the
/// audit trail even though the flag itself does not.
///
/// Registered as a singleton: the state is per-rig, not per-request.
/// </summary>
public sealed class LoadSheddingStateStore
{
    private readonly object _gate = new();
    private LoadSheddingState _state = LoadSheddingState.Initial;

    public LoadSheddingState Current
    {
        get
        {
            lock (_gate)
            {
                return _state;
            }
        }
    }

    public LoadSheddingState Update(Func<LoadSheddingState, LoadSheddingState> mutate)
    {
        lock (_gate)
        {
            _state = mutate(_state);
            return _state;
        }
    }
}