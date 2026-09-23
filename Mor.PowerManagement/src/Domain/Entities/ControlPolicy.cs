namespace Mor.PowerManagement.Domain.Entities;

// One ECA control rule (POL-01..POL-08) from the policy repository.
public class ControlPolicy : BaseAuditableEntity
{
    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Condition { get; set; } = string.Empty;

    public string Action { get; set; } = string.Empty;
}
