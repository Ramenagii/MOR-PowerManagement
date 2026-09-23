namespace Mor.PowerManagement.Domain.Entities;

// Dashboard event-log entry, mirroring the frontend EventLog type.
public class PowerEvent : BaseAuditableEntity
{
    public DateTimeOffset Timestamp { get; set; }

    public string Title { get; set; } = string.Empty;

    public string Detail { get; set; } = string.Empty;

    public EventSeverity Severity { get; set; } = EventSeverity.Info;
}
