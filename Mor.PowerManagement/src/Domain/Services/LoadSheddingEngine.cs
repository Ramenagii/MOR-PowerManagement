using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Domain.Services;

/// <summary>Which branch the framework wants to act on, and why.</summary>
public enum LoadSheddingAction
{
    /// <summary>Nothing to do: inside limits, confirmation pending, or a timer not yet elapsed.</summary>
    None,

    /// <summary>Open the relay on <see cref="LoadSheddingDecision.OutletId"/>.</summary>
    Shed,

    /// <summary>Reclose the relay on <see cref="LoadSheddingDecision.OutletId"/>.</summary>
    Restore,

    /// <summary>Raise an alarm event; never assume the rig is safe.</summary>
    Alarm,
}

/// <summary>One shedded branch, remembered so restoration can be staged and ordered.</summary>
public sealed record ShedRecord(
    int OutletId,
    LoadTier Tier,
    double WattsAtShed,
    DateTimeOffset ShedAtUtc,
    bool OutletAllowanceTrip = false);

/// <summary>
/// Cross-batch framework state. Immutable: each evaluation returns the next
/// state and the caller stores it, so a decision is always explainable after the
/// fact ("why was this shed?" = the ledger plus the counter that armed it).
/// </summary>
public sealed record LoadSheddingState
{
    public static readonly LoadSheddingState Initial = new();

    /// <summary>Consecutive fresh batches seen at or above P_limit (diagnostic only).</summary>
    public int ConsecutiveOverLimitBatches { get; init; }

    /// <summary>First fresh sample in the current sustained system-overload interval.</summary>
    public DateTimeOffset? OverLimitSinceUtc { get; init; }

    /// <summary>Timestamp of the last fresh sample used to confirm system overload.</summary>
    public DateTimeOffset? LastOverLimitSampleUtc { get; init; }

    /// <summary>Consecutive fresh batches above each energized outlet's own allowance.</summary>
    public IReadOnlyDictionary<int, int> ConsecutiveOutletOverLimitBatches { get; init; }
        = new Dictionary<int, int>();

    /// <summary>Outlets this framework shed, oldest first.</summary>
    public IReadOnlyList<ShedRecord> ShedLedger { get; init; } = Array.Empty<ShedRecord>();

    /// <summary>When P_total first fell below the recovery limit in the current streak.</summary>
    public DateTimeOffset? BelowRecoveryLimitSinceUtc { get; init; }

    /// <summary>When the last staged reconnection happened; gates the inter-reconnect delay.</summary>
    public DateTimeOffset? LastReconnectUtc { get; init; }

    /// <summary>
    /// Operator override: automatic prioritisation is disabled and only the
    /// operator may shed or restore. Latched here so every evaluation sees it.
    /// </summary>
    public bool ManualOverride { get; init; }

    /// <summary>A fault (invalid data, unknown status, unsheddable overload) has been seen and not cleared.</summary>
    public bool FaultLatched { get; init; }
}

public sealed record LoadSheddingDecision(
    LoadSheddingAction Action,
    int? OutletId,
    LoadTier? Tier,
    string Detail,
    LoadSheddingState NextState,
    double RecoveryLimitWatts,
    int ConsecutiveOverLimitBatches,
    int OverLimitConfirmationSeconds);

/// <summary>A branch whose reported data cannot be trusted.</summary>
public sealed record SensorFault(int OutletId, string Reason);

/// <summary>
/// The priority-based load shedding and staged restoration framework.
///
/// A PURE decision function: it takes the measured rig, the limit and the
/// previous state, and returns the single next action. It touches no database,
/// no clock and no network - the caller supplies <c>now</c> - which is what
/// makes the whole ladder reproducible for thesis evaluation.
///
/// Shape of one cycle:
///   at/over P_limit -> confirm 3 s of fresh readings -> shed ONE lowest-tier
///                    branch -> remeasure on the next batch -> repeat while
///                    still over
///   under recovery-> wait the recovery period -> reclose ONE highest-tier
///                    shedded branch -> wait the inter-reconnect delay ->
///                    remeasure -> repeat
///
/// One branch per batch is deliberate. "Remeasure" cannot happen inside this
/// function because the measurement does not exist yet; shedding several
/// branches per batch would re-create the inrush that caused the overload and
/// would make it impossible to attribute the recovery to any one outlet.
///
/// PROTOTYPE ONLY. This is software logic layered over a live electrical rig.
/// It is never a substitute for fuses, breakers and RCD/GFCI protection, and
/// an overload it fails to shed remains a real electrical fault.
/// </summary>
public static class LoadSheddingEngine
{
    /// <summary>
    /// The restoration limit: P_limit less the hysteresis band. P_total must
    /// clear THIS, not P_limit, before anything is reconnected - otherwise the
    /// first restored outlet tips the rig straight back over.
    /// </summary>
    public static double ComputeRecoveryLimit(double pLimitWatts)
        => Math.Max(pLimitWatts * (1 - LoadSheddingSettings.RecoveryHysteresisFraction), 0);

    /// <summary>
    /// The next branch to shed: most expendable tier first, then highest
    /// current within that tier. Tier 1 is excluded outright (FR-09 priority
    /// preservation) - the framework will not disconnect an outlet the operator
    /// declared essential, it will alarm instead.
    /// </summary>
    public static IReadOnlyList<OutletLoadSnapshot> SelectNextShed(IEnumerable<OutletLoadSnapshot> outlets, int count)
        => outlets
            .Where(LoadTierMapper.IsAutoSheddable)
            .OrderByDescending(o => (int)LoadTierMapper.ToTier(o.Priority))
            .ThenByDescending(o => o.Watts)
            .ThenBy(o => o.Id)
            .Take(Math.Max(count, 0))
            .ToList();

    /// <summary>
    /// The next branch to restore: most important tier first, so the outlet the
    /// operator cares about most is the first one back.
    /// </summary>
    public static IReadOnlyList<OutletLoadSnapshot> SelectNextRestore(
        IEnumerable<OutletLoadSnapshot> outlets,
        IEnumerable<ShedRecord> ledger,
        int count)
    {
        var byId = outlets.ToDictionary(o => o.Id);

        return ledger
            .Where(record => byId.ContainsKey(record.OutletId)
                && LoadTierMapper.IsAutoRestorable(byId[record.OutletId]))
            .OrderBy(record => (int)LoadTierMapper.ToTier(byId[record.OutletId].Priority))
            .ThenByDescending(record => record.WattsAtShed)
            .ThenBy(record => record.OutletId)
            .Take(Math.Max(count, 0))
            .Select(record => byId[record.OutletId])
            .ToList();
    }

    /// <summary>
    /// Per-outlet allowance assessment. Priority never bypasses the configured
    /// allowance under the current framework policy.
    /// <summary>
    public static ActivationAssessment AssessOutletAllowance(
        OutletLoadSnapshot outlet,
        double currentOutletWatts,
        IReadOnlyCollection<int> capExemptOutletIds)
    {
        var tier = LoadTierMapper.ToTier(outlet.Priority);

        if (capExemptOutletIds.Contains(outlet.Id))
        {
            return new ActivationAssessment(
                ActivationVerdict.Allowed,
                "POL-02",
                $"{Display(outlet)} is exempt from its per-outlet allowance cap, but still counted in P_total.");
        }

        if (currentOutletWatts > outlet.AllowanceWatts)
        {
            return new ActivationAssessment(
                ActivationVerdict.Blocked,
                "POL-03",
                $"{Display(outlet)} is drawing {currentOutletWatts:F0} W against a per-outlet allowance of {outlet.AllowanceWatts:F0} W ({tier}).");
        }

        return new ActivationAssessment(
            ActivationVerdict.Allowed,
            "POL-02",
            $"{Display(outlet)} is within its per-outlet allowance of {outlet.AllowanceWatts:F0} W ({tier}).");
    }

    // Operator-facing label for a branch, falling back to the id when the
    // snapshot was built without a name.
    private static string Display(OutletLoadSnapshot outlet)
        => string.IsNullOrWhiteSpace(outlet.Name) ? $"Outlet {outlet.Id}" : outlet.Name;

    /// <summary>
    /// Branches whose data cannot be trusted. A branch is not assumed to be
    /// drawing zero: unknown is reported as unknown, because zero is the one
    /// value that looks safe and is used to justify skipping a shed.
    /// </summary>
    public static IReadOnlyList<SensorFault> InspectSensorHealth(
        IEnumerable<OutletLoadSnapshot> outlets,
        double pLimitWatts,
        double totalWatts,
        DateTimeOffset now)
    {
        var faults = new List<SensorFault>();

        foreach (var outlet in outlets)
        {
            if (double.IsNaN(outlet.Watts) || double.IsInfinity(outlet.Watts) || outlet.Watts < 0)
            {
                faults.Add(new SensorFault(outlet.Id, $"impossible power reading ({outlet.Watts})."));
                continue;
            }

            if (outlet.Watts > LoadSheddingSettings.MaxPlausibleBranchWatts)
            {
                faults.Add(new SensorFault(outlet.Id, $"implausible power reading ({outlet.Watts:F0} W)."));
                continue;
            }

            // Only meaningful while deciding: a stale reading on a quiet rig is
            // an offline device (already surfaced as such), but a stale reading
            // on an OVERLOADED rig means P_total itself is untrustworthy, which
            // is the case that must never be read as "safe".
            if (totalWatts > pLimitWatts)
            {
                if (!outlet.LastSeen.HasValue)
                {
                    faults.Add(new SensorFault(outlet.Id, "no reading has ever been received for this branch."));
                }
                else if (outlet.LastSeen.Value < now.AddSeconds(-LoadSheddingSettings.SensorStalenessSeconds))
                {
                    faults.Add(new SensorFault(outlet.Id, $"reading is stale (last seen {outlet.LastSeen.Value:HH:mm:ss}Z)."));
                }
            }
        }

        return faults;
    }

    /// <summary>
    /// One tick of the framework. <paramref name="now"/> is injected so the
    /// decision is a pure function of its inputs.
    /// </summary>
    public static LoadSheddingDecision Evaluate(
        IReadOnlyList<OutletLoadSnapshot> outlets,
        double pLimitWatts,
        LoadSheddingState state,
        DateTimeOffset now)
    {
        var recoveryLimit = ComputeRecoveryLimit(pLimitWatts);
        var total = LoadResponseEvaluator.TotalLoad(outlets);
        // Match the dashboard's Critical state and the outlet-allowance rule:
        // reaching P_limit counts as overload, not only crossing above it.
        var overLimit = total >= pLimitWatts;

        // ---- 1. Never assume safe. Sensor faults outrank every other action:
        // if the numbers are untrustworthy the framework says so and stops.
        var faults = InspectSensorHealth(outlets, pLimitWatts, total, now);
        if (faults.Count > 0)
        {
            var next = state with
            {
                ConsecutiveOverLimitBatches = 0,
                OverLimitSinceUtc = null,
                LastOverLimitSampleUtc = null,
                ConsecutiveOutletOverLimitBatches = new Dictionary<int, int>(),
                FaultLatched = true,
            };
            return new LoadSheddingDecision(
                LoadSheddingAction.Alarm,
                null,
                null,
                $"Measurement fault on {faults.Count} branch(es): {string.Join(" ", faults.Select(f => $"Outlet {f.OutletId} - {f.Reason}"))}. " +
                "Automatic shedding suspended; the rig is NOT assumed safe.",
                next,
                recoveryLimit,
                next.ConsecutiveOverLimitBatches,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        // An outlet at or above its own configured allowance is disconnected
        // on the first fresh batch, regardless of priority, then tracked in the
        // same timed restore ledger.
        var outletCounters = new Dictionary<int, int>();
        foreach (var outlet in outlets)
        {
            var fresh = outlet.LastSeen is { } lastSeen
                && lastSeen >= now.AddSeconds(-LoadSheddingSettings.SensorStalenessSeconds);
            var overAllowance = !state.ManualOverride
                && !LoadTierMapper.IsMonitoredOnlyOutlet(outlet.Id)
                && LoadResponseEvaluator.IsEnergized(outlet.Status)
                && fresh
                && outlet.Watts >= outlet.AllowanceWatts;
            outletCounters[outlet.Id] = overAllowance
                ? state.ConsecutiveOutletOverLimitBatches.GetValueOrDefault(outlet.Id) + 1
                : 0;
        }

        state = state with { ConsecutiveOutletOverLimitBatches = outletCounters };

        if (!state.ManualOverride)
        {
            var overAllowance = outlets
                .Where(o => !LoadTierMapper.IsMonitoredOnlyOutlet(o.Id))
                .Where(o => !o.IsProtected)
                .Where(o => outletCounters[o.Id] >= LoadSheddingSettings.OutletAllowanceConfirmationBatches)
                .OrderByDescending(o => o.Watts - o.AllowanceWatts)
                .ThenBy(o => o.Id)
                .FirstOrDefault();

            if (overAllowance is not null)
            {
                var tier = LoadTierMapper.ToTier(overAllowance.Priority);
                var shedState = state with
                {
                    ConsecutiveOutletOverLimitBatches = outletCounters
                        .Where(pair => pair.Key != overAllowance.Id)
                        .ToDictionary(pair => pair.Key, pair => pair.Value),
                    BelowRecoveryLimitSinceUtc = null,
                    ShedLedger = state.ShedLedger
                        .Where(record => record.OutletId != overAllowance.Id)
                        .Append(new ShedRecord(
                            overAllowance.Id,
                            tier,
                            overAllowance.Watts,
                            now,
                            OutletAllowanceTrip: true))
                        .ToList(),
                    FaultLatched = false,
                };

                return new LoadSheddingDecision(
                    LoadSheddingAction.Shed,
                    overAllowance.Id,
                    tier,
                    $"{Display(overAllowance)} drew {overAllowance.Watts:F0} W, at or above its {overAllowance.AllowanceWatts:F0} W outlet limit. Opening its relay.",
                    shedState,
                    recoveryLimit,
                    outletCounters[overAllowance.Id],
                    LoadSheddingSettings.OutletAllowanceConfirmationBatches);
            }
        }

        // ---- 2. Overload path: confirm, then shed one branch per batch.
        if (overLimit)
        {
            var gap = state.LastOverLimitSampleUtc is { } lastSample ? now - lastSample : TimeSpan.MaxValue;
            var uninterrupted = gap >= TimeSpan.Zero
                && gap <= TimeSpan.FromSeconds(LoadSheddingSettings.MaxOverLimitSampleGapSeconds);
            var startedAt = uninterrupted ? state.OverLimitSinceUtc ?? now : now;
            var elapsed = now - startedAt;
            var counter = uninterrupted ? state.ConsecutiveOverLimitBatches + 1 : 1;
            var confirmed = state with
            {
                ConsecutiveOverLimitBatches = counter,
                OverLimitSinceUtc = startedAt,
                LastOverLimitSampleUtc = now,
                BelowRecoveryLimitSinceUtc = null,
            };

            if (elapsed < TimeSpan.FromSeconds(LoadSheddingSettings.OverLimitConfirmationSeconds))
            {
                return new LoadSheddingDecision(
                    LoadSheddingAction.None,
                    null,
                    null,
                    $"P_total {total:F1} W is at or above P_limit {pLimitWatts:F1} W; sustained for {elapsed.TotalSeconds:F1}/{LoadSheddingSettings.OverLimitConfirmationSeconds} s.",
                    confirmed,
                    recoveryLimit,
                    counter,
                    LoadSheddingSettings.OverLimitConfirmationSeconds);
            }

            if (state.ManualOverride)
            {
                return new LoadSheddingDecision(
                    LoadSheddingAction.None,
                    null,
                    null,
                    $"P_total {total:F1} W is at or above P_limit {pLimitWatts:F1} W, but the operator has disabled automatic prioritisation. Manual action required.",
                    confirmed,
                    recoveryLimit,
                    counter,
                    LoadSheddingSettings.OverLimitConfirmationSeconds);
            }

            var next = SelectNextShed(outlets, 1).FirstOrDefault();
            if (next is null)
            {
                // Everything the framework is willing to shed is already off and
                // the rig is STILL over the limit. The remaining load is tier 1
                // (or unshedded) and the framework will not cut it on its own.
                // That is a real, unresolved overload: alarm, never assume safe.
                var latched = confirmed with { FaultLatched = true };
                return new LoadSheddingDecision(
                    LoadSheddingAction.Alarm,
                    null,
                    null,
                    $"P_total {total:F1} W is still at or above P_limit {pLimitWatts:F1} W after shedding every eligible branch. " +
                    "The remaining load is highest-priority load the framework will not disconnect automatically; " +
                    "the rig is NOT assumed safe and needs operator intervention.",
                    latched,
                    recoveryLimit,
                    counter,
                    LoadSheddingSettings.OverLimitConfirmationSeconds);
            }

            var tier = LoadTierMapper.ToTier(next.Priority);
            var shedState = confirmed with
            {
                ShedLedger = state.ShedLedger
                    .Append(new ShedRecord(next.Id, tier, next.Watts, now))
                    .ToList(),
                FaultLatched = false,
            };

            return new LoadSheddingDecision(
                LoadSheddingAction.Shed,
                next.Id,
                tier,
                $"P_total {total:F1} W stayed at or above P_limit {pLimitWatts:F1} W for at least {LoadSheddingSettings.OverLimitConfirmationSeconds} s. " +
                $"Shedding Outlet {next.Id} ({tier}, {next.Watts:F0} W) as the most expendable active load.",
                shedState,
                recoveryLimit,
                counter,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        // ---- 3. Timed recovery ladder.
        // Recovery is time-based by design: after an automatic OFF, allow a
        // measured trial even when total demand remains high, then evaluate the
        // fresh post-switch telemetry and return the same outlet OFF if needed.
        state = state with
        {
            ConsecutiveOverLimitBatches = 0,
            OverLimitSinceUtc = null,
            LastOverLimitSampleUtc = null,
        };

        var recoveryStarted = state.BelowRecoveryLimitSinceUtc ?? now;
        var sinceRecovery = now - recoveryStarted;

        if (sinceRecovery < TimeSpan.FromSeconds(LoadSheddingSettings.RecoveryPeriodSeconds))
        {
            var waiting = state with
            {
                ConsecutiveOverLimitBatches = 0,
                OverLimitSinceUtc = null,
                LastOverLimitSampleUtc = null,
                BelowRecoveryLimitSinceUtc = recoveryStarted,
                FaultLatched = false,
            };

            return new LoadSheddingDecision(
                LoadSheddingAction.None,
                null,
                null,
                $"Timed recovery wait: {sinceRecovery.TotalSeconds:F0}/{LoadSheddingSettings.RecoveryPeriodSeconds} s; holding shed branches.",
                waiting,
                recoveryLimit,
                waiting.ConsecutiveOverLimitBatches,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        if (state.ShedLedger.Count == 0)
        {
            var idle = state with
            {
                ConsecutiveOverLimitBatches = 0,
                OverLimitSinceUtc = null,
                LastOverLimitSampleUtc = null,
                BelowRecoveryLimitSinceUtc = null,
                FaultLatched = false,
            };

            return new LoadSheddingDecision(
                LoadSheddingAction.None,
                null,
                null,
                $"P_total {total:F0} W is healthy; nothing shed by the framework is waiting to be restored.",
                idle,
                recoveryLimit,
                idle.ConsecutiveOverLimitBatches,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        if (state.ManualOverride)
        {
            return new LoadSheddingDecision(
                LoadSheddingAction.None,
                null,
                null,
                $"{state.ShedLedger.Count} branch(es) are shed and the rig is healthy, but the operator has disabled automatic prioritisation. Manual restoration required.",
                state with { ConsecutiveOverLimitBatches = 0, OverLimitSinceUtc = null, LastOverLimitSampleUtc = null, BelowRecoveryLimitSinceUtc = null },
                recoveryLimit,
                0,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        // Inter-reconnect delay: one reclose, then wait a full delay before the
        // next, so the rig is remeasured between every staged restoration.
        if (state.LastReconnectUtc is { } lastReconnect
            && now - lastReconnect < TimeSpan.FromSeconds(LoadSheddingSettings.InterReconnectDelaySeconds))
        {
            return new LoadSheddingDecision(
                LoadSheddingAction.None,
                null,
                null,
                $"Inter-reconnect delay active; next staged restoration in " +
                $"{(TimeSpan.FromSeconds(LoadSheddingSettings.InterReconnectDelaySeconds) - (now - lastReconnect)).TotalSeconds:F0} s.",
                state,
                recoveryLimit,
                0,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        var nextRestore = SelectNextRestore(outlets, state.ShedLedger, 1).FirstOrDefault();
        if (nextRestore is null)
        {
            var cleared2 = state with
            {
                ConsecutiveOverLimitBatches = 0,
                OverLimitSinceUtc = null,
                LastOverLimitSampleUtc = null,
                BelowRecoveryLimitSinceUtc = null,
                FaultLatched = false,
            };

            return new LoadSheddingDecision(
                LoadSheddingAction.None,
                null,
                null,
                $"P_total {total:F0} W is healthy; no shed branch is eligible for automatic restoration.",
                cleared2,
                recoveryLimit,
                cleared2.ConsecutiveOverLimitBatches,
                LoadSheddingSettings.OverLimitConfirmationSeconds);
        }

        var restoreTier = LoadTierMapper.ToTier(nextRestore.Priority);
        var restored = state with
        {
            ConsecutiveOverLimitBatches = 0,
            OverLimitSinceUtc = null,
            LastOverLimitSampleUtc = null,
            BelowRecoveryLimitSinceUtc = null,
            LastReconnectUtc = now,
            ShedLedger = state.ShedLedger.Where(r => r.OutletId != nextRestore.Id).ToList(),
            FaultLatched = false,
        };

        return new LoadSheddingDecision(
            LoadSheddingAction.Restore,
            nextRestore.Id,
            restoreTier,
            $"Timed recovery wait of {sinceRecovery.TotalSeconds:F0} s elapsed. Trial-restoring Outlet {nextRestore.Id} ({restoreTier}); fresh readings determine whether it stays on.",
            restored,
            recoveryLimit,
            restored.ConsecutiveOverLimitBatches,
            LoadSheddingSettings.OverLimitConfirmationSeconds);
    }
}
