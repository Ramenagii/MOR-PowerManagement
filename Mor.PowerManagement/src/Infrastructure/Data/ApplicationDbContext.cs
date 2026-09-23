using System.Reflection;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Mor.PowerManagement.Infrastructure.Data;

public class ApplicationDbContext : IdentityDbContext<ApplicationUser>, IApplicationDbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options) { }

    public DbSet<TodoList> TodoLists => Set<TodoList>();

    public DbSet<TodoItem> TodoItems => Set<TodoItem>();

    public DbSet<Outlet> Outlets => Set<Outlet>();

    public DbSet<TelemetryReading> TelemetryReadings => Set<TelemetryReading>();

    public DbSet<PowerSystemConfig> PowerSystemConfigs => Set<PowerSystemConfig>();

    public DbSet<ControlPolicy> ControlPolicies => Set<ControlPolicy>();

    public DbSet<PowerEvent> PowerEvents => Set<PowerEvent>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly());
    }
}
