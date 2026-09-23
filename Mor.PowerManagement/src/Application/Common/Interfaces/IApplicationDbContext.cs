using Mor.PowerManagement.Domain.Entities;

namespace Mor.PowerManagement.Application.Common.Interfaces;

public interface IApplicationDbContext
{
    DbSet<TodoList> TodoLists { get; }

    DbSet<TodoItem> TodoItems { get; }

    DbSet<Outlet> Outlets { get; }

    DbSet<TelemetryReading> TelemetryReadings { get; }

    DbSet<PowerSystemConfig> PowerSystemConfigs { get; }

    DbSet<ControlPolicy> ControlPolicies { get; }

    DbSet<PowerEvent> PowerEvents { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken);
}
