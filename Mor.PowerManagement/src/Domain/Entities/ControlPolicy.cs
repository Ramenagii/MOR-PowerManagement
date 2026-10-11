namespace Mor.PowerManagement.Domain.Entities;

// One ECA framework rule (FR-01..FR-12) from the rule repository.
// POL-xx is kept in LegacyCode so earlier manuscript panels remain quotable.
public class ControlPolicy : BaseAuditableEntity
{
    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Condition { get; set; } = string.Empty;

    public string Action { get; set; } = string.Empty;

    // Superseded identifier (POL-01..POL-08). Null for rules with no legacy code.
    public string? LegacyCode { get; set; }

    // Rule family: Safety/Interlock, PreActivation, PostActivation,
    // DemandSide, Idle, Measurement/Audit.
    public string RuleFamily { get; set; } = string.Empty;

    // Precedence position: the lowest number that fires wins for a branch in
    // a given evaluation tick (see MUST_READ.md section 3).
    public int Precedence { get; set; } = 100;

    // Disabled rules are kept for documentation but never evaluated.
    public bool Enabled { get; set; } = true;
}
