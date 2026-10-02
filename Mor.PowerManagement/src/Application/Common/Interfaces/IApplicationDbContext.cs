using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore.Infrastructure;

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

    // Exposed so handlers can run a server-side aggregate via EF's
    // Database.SqlQuery<T> without taking a dependency on Infrastructure (D3).
    DatabaseFacade Database { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken);
}
