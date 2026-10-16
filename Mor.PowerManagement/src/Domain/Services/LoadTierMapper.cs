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
    /// The one outlet whose own per-outlet allowance cap does not
    /// apply: a tier-1 outlet, lowest outlet id breaking a tie. Deterministic on
    /// purpose - an exemption that moved between calls would make activation
    /// decisions non-reproducible.
    /// </summary>
    public static int? SelectCapExemptOutletId(IEnumerable<OutletLoadSnapshot> outlets)
    {
        // Only tier 1 is ever exempt; a lower tier gets no exemption regardless
        // of how it ranks against its neighbours, because "the best outlet on
        // this rig" must not silently mean "whichever outlet happens to be
        // least important".
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
    /// Every outlet exempt from its own per-outlet cap. Normally a single tier-1
    /// outlet; a tie is broken by lowest id so the set is deterministic.
    /// </summary>
    public static IReadOnlyCollection<int> SelectCapExemptOutletIds(IEnumerable<OutletLoadSnapshot> outlets)
    {
        var exempt = SelectCapExemptOutletId(outlets);

        return exempt.HasValue ? new[] { exempt.Value } : Array.Empty<int>();
    }

    /// <summary>
    /// Whether the framework may open this outlet's relay on its own.
    /// <para>
    /// Tier 1 (Critical) is never auto-shed, whatever P_total is: that is FR-09
    /// priority preservation, and it is a SEPARATE decision from the per-outlet
    /// cap exemption above. Cap exemption is about the outlet's own allowance
    /// accounting; shed eligibility is about what the framework is willing to
    /// disconnect. Conflating them would mean either capping an essential
    /// outlet or making an inessential outlet unshe-ddable.
    /// </para>
    /// <para>
    /// Manual shed (the operator's own button) is unaffected - an operator can
    /// still disconnect an essential outlet deliberately. Only AUTOMATIC
    /// prioritisation is withheld.
    /// </para>
    /// </summary>
    public static bool IsAutoSheddable(OutletLoadSnapshot outlet)
        => LoadResponseEvaluator.IsEnergized(outlet.Status)
            && ToTier(outlet.Priority) != LoadTier.Critical;

    /// <summary>
    /// Whether the outage's restoration ladder may reclose this outlet. The
    /// mirror of <see cref="IsAutoSheddable"/>: only outlets the framework is
    /// willing to shed are ones it is willing to put back.
    /// </summary>
    public static bool IsAutoRestorable(OutletLoadSnapshot outlet)
        => outlet.Status == OutletStatus.Disconnected
            && ToTier(outlet.Priority) != LoadTier.Critical;
}