namespace Mor.PowerManagement.Domain.Enums;

// The thesis load-shedding tiers. Deliberately separate from OutletPriority:
// OutletPriority is the legacy 1-4 rank the dashboard, the seed and the
// firmware already speak (Low=1 shed first, Critical=4 shed last), while
// LoadTier is the named, thesis-facing vocabulary the framework reasons in.
//
// THE MAPPING IS 1:1 AND INVERTED, because "low priority" and "high tier" are
// opposite sentences about the same outlet:
//
//   OutletPriority.Critical (4) -> LoadTier.Critical     (1) keep powered
//   OutletPriority.High     (3) -> LoadTier.Important    (2)
//   OutletPriority.Medium   (2) -> LoadTier.Deferrable   (3)
//   OutletPriority.Low      (1) -> LoadTier.Nonessential (4) shed first
//
// Both enumerations are stored as small ints, so the DB column is untouched by
// the introduction of LoadTier - only the domain vocabulary is added. See
// LoadTierMapper for the conversion, which is the ONLY place the two meet.
//
// Numeric rank is deliberately NOT shed order: Critical is 1, Nonessential is
// 4. So "more important than" is `<` and "shed the most expendable first" is
// OrderByDescending(tier). Getting this backwards would shed the workstation
// before the charger, so the rule is stated once here rather than repeated.
public enum LoadTier
{
    // Tier 1: keep powered. Effectively exempt from any per-outlet cap (see
    // LoadSheddingSettings.CriticalTierIsCapExempt) but still counted in
    // P_total, because a no-limit outlet that is never measured is exactly how
    // a rig overloads.
    Critical = 1,

    // Tier 2: shed only after every tier 3 and tier 4 outlet is already off.
    Important = 2,

    // Tier 3: shed first among the loads that are actually in use.
    Deferrable = 3,

    // Tier 4: shed first, always. This is where charging cables, monitors and
    // other convenience load belongs.
    Nonessential = 4,
}