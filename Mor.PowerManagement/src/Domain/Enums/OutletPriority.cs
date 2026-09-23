namespace Mor.PowerManagement.Domain.Enums;

// Rank values mirror the dashboard priorityRank table:
// Critical (4) is shed last, Low (1) is shed first.
public enum OutletPriority
{
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4
}
