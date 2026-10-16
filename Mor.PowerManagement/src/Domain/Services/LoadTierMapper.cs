using Mor.PowerManagement.Domain.Constants;

namespace Mor.PowerManagement.Domain.Services;

/// <summary>
/// The single conversion point between the legacy <see cref="OutletPriority"/>
/// rank and the thesis <see cref="LoadTier"/> vocabulary. Documented on
/// <see cref="LoadTier"/>; kept here so no other file has to restate it.
/// </summary>
public static class LoadTierMapper
{
    // OutletPriority.Low is shed first (rank 1) and LoadTier.Nonessential is
    // shed first (rank 4), so the two scales run opposite ways and the
    // conversion must invert rather than copy.
    public static LoadTier ToTier(OutletPriority priority) => priority switch
    {
        OutletPriority.Critical => LoadTier.Critical,
        OutletPriority.High => LoadTier.Important,
        OutletPriority.Medium => LoadTier.Deferrable,
        OutletPriority.Low => LoadTier.Nonessential,

        // An unrecognised rank must not be silently treated as the most
        // expendable load: shedding it first is a physical action on someone's
        // equipment. Unknown ranks map to Important, which the framework still
        // protects from first-pass shedding.
        _ => LoadTier.Important,
    };

    // Tier -> rank, so a policy write can be round-tripped back to the stored
    // OutletPriority the dashboard and firmware already understand.
    public static OutletPriority ToPriority(LoadTier tier) => tier switch
    {
        LoadTier.Critical => OutletPriority.Critical,
        LoadTier.Important => OutletPriority.High,
        LoadTier.Deferrable => OutletPriority.Medium,
        LoadTier.Nonessential => OutletPriority.Low,
        _ => OutletPriority.High,
    };

    /// <summary>
    /// The legacy exemption hook. Current framework settings keep per-outlet
    /// allowances enabled for every tier, so this returns null.
    /// </summary>
    public static int? SelectCapExemptOutletId(IEnumerable<OutletLoadSnapshot> outlets)
    {
        // Retained for compatibility with the framework setting. The current
        // four-outlet policy has no allowance-exempt tier.
        var tier1 = outlets
            .Where(o => ToTier(o.Priority) == LoadTier.Critical)
            .OrderBy(o => o.Id)
            .FirstOrDefault();

        // Expressed as a ternary rather than an early return so the setting
        // stays the single readable switch: flipping the const to false
        // removes the exemption without editing this method.
        return LoadSheddingSettings.CriticalTierIsCapExempt ? tier1?.Id : null;
    }

    /// <summary>
    /// Outlet IDs exempt from their own per-outlet allowance. Empty under the
    /// current policy, where every tier has an allowance.
    /// </summary>
    public static IReadOnlyCollection<int> SelectCapExemptOutletIds(IEnumerable<OutletLoadSnapshot> outlets)
    {
        var exempt = SelectCapExemptOutletId(outlets);

        return exempt.HasValue ? new[] { exempt.Value } : Array.Empty<int>();
    }

    /// <summary>
    /// Whether the framework may open this outlet's relay on its own.
    /// <para>
    /// Staff protection is independent from priority. A Critical priority can
    /// still be shed when it is not explicitly protected; a protected outlet
    /// is never a routine automatic-shedding candidate.
    /// </para>
    /// <para>
    /// Manual shed (the operator's own button) is unaffected - an operator can
    /// still disconnect an essential outlet deliberately. Only AUTOMATIC
    /// prioritisation is withheld.
    /// </para>
    /// </summary>
    public static bool IsAutoSheddable(OutletLoadSnapshot outlet)
        => LoadResponseEvaluator.IsEnergized(outlet.Status)
            && !outlet.IsProtected;

    /// <summary>
    /// Whether the outage's restoration ladder may reclose this outlet. The
    /// mirror of <see cref="IsAutoSheddable"/>: only outlets the framework is
    /// willing to shed are ones it is willing to put back.
    /// </summary>
    public static bool IsAutoRestorable(OutletLoadSnapshot outlet)
        => outlet.Status == OutletStatus.Disconnected
            && !outlet.IsProtected
            && !outlet.ManualHold
            && !outlet.RecoveryLockout
            && outlet.AutomaticRecoveryAttempts < 5;
}
