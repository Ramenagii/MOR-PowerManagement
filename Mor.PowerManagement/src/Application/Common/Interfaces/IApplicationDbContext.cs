using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Infrastructure;

namespace Mor.PowerManagement.Application.Common.Interfaces;

public interface IApplicationDbContext
{
    DbSet<TodoList> TodoLists { get; }

    DbSet<TodoItem> TodoItems { get; }

    DbSet<Outlet> Outlets { get; }

    DbSet<TelemetryReading> TelemetryReadings { get; }

    DbSet<InaReading> InaReadings { get; }

    DbSet<PowerSystemConfig> PowerSystemConfigs { get; }

    DbSet<ControlPolicy> ControlPolicies { get; }

    DbSet<PowerEvent> PowerEvents { get; }

    // Batched history writer progress (PLAN-0001 Spec E).
    DbSet<TelemetryPersistenceCheckpoint> TelemetryPersistenceCheckpoints { get; }

    // Seven-day raw compaction and 30-day minute tier (PLAN-0001 Spec F).
    DbSet<TelemetryMinuteRollup> TelemetryMinuteRollups { get; }

    DbSet<InaMinuteRollup> InaMinuteRollups { get; }

    DbSet<TelemetryCompactionCheckpoint> TelemetryCompactionCheckpoints { get; }

    // Exposed so handlers can run a server-side aggregate via EF's
    // Database.SqlQuery<T> without taking a dependency on Infrastructure (D3).
    DatabaseFacade Database { get; }

    // Exposed so runtime-ingest handlers can attach detached runtime copies
    // and mark live-only fields unmodified without querying (PLAN-0001 Spec E).
    EntityEntry<TEntity> Entry<TEntity>(TEntity entity) where TEntity : class;

    Task<int> SaveChangesAsync(CancellationToken cancellationToken);
}
