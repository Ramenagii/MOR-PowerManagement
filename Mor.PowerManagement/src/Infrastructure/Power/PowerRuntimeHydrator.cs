using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;

namespace Mor.PowerManagement.Infrastructure.Power;

/// <summary>
/// Loads the durable part of the runtime snapshot: five read-only queries,
/// once per process (or again on demand after a failed hydration). Nothing is
/// tracked and the scope is disposed before the snapshot is returned.
/// </summary>
public sealed class PowerRuntimeHydrator : IPowerRuntimeHydrator
{
    private readonly Func<CancellationToken, Task<PowerRuntimeSnapshot>> _load;

    public PowerRuntimeHydrator(IServiceScopeFactory scopes, TimeProvider timeProvider)
    {
        _load = async cancellationToken =>
        {
            using var scope = scopes.CreateScope();
            var context = scope.ServiceProvider.GetRequiredService<IApplicationDbContext>();
            return await LoadAsync(context, timeProvider.GetUtcNow(), cancellationToken);
        };
    }

    /// <summary>For callers that own the context lifetime (tests, tools).</summary>
    public PowerRuntimeHydrator(Func<IApplicationDbContext> contextFactory, TimeProvider timeProvider)
    {
        _load = async cancellationToken =>
        {
            var context = contextFactory();
            try
            {
                return await LoadAsync(context, timeProvider.GetUtcNow(), cancellationToken);
            }
            finally
            {
                if (context is IAsyncDisposable disposable) await disposable.DisposeAsync();
            }
        };
    }

    public Task<PowerRuntimeSnapshot> LoadAsync(CancellationToken cancellationToken) => _load(cancellationToken);

    public static async Task<PowerRuntimeSnapshot> LoadAsync(IApplicationDbContext context, DateTimeOffset now, CancellationToken cancellationToken)
    {
        // Same single-row read as every legacy handler (one configuration row).
        var config = await context.PowerSystemConfigs
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        var outlets = await context.Outlets
            .AsNoTracking()
            .OrderBy(o => o.Id)
            .ToListAsync(cancellationToken);

        var events = await context.PowerEvents
            .AsNoTracking()
            .OrderByDescending(e => e.Timestamp)
            .ThenByDescending(e => e.Id)
            .Take(PowerRuntimeSnapshot.RecentEventCapacity)
            .ToListAsync(cancellationToken);

        // Only samples that can still fall inside a later 30 s cutoff.
        var horizon = now.AddSeconds(-RuntimeVoltageWindow.WindowSeconds);
        var voltage = await context.TelemetryReadings
            .AsNoTracking()
            .Where(r => r.Timestamp >= horizon && r.Voltage > 0)
            .OrderBy(r => r.Timestamp)
            .ThenBy(r => r.Id)
            .Select(r => new { r.OutletId, r.Timestamp, r.Voltage })
            .ToListAsync(cancellationToken);

        // The newest INA226 sample of any age; projections decide freshness.
        var latestIna = await context.InaReadings
            .AsNoTracking()
            .OrderByDescending(r => r.Timestamp)
            .ThenByDescending(r => r.Id)
            .FirstOrDefaultAsync(cancellationToken);

        return new PowerRuntimeSnapshot
        {
            HydratedAtUtc = RuntimeTime.Normalize(now),
            Config = config is null ? null : RuntimeConfig.From(config),
            Outlets = outlets.Select(o => RuntimeOutlet.From(o)).ToImmutableArray(),
            RecentEvents = PowerRuntimeSnapshot.OrderEvents(events.Select(RuntimeEvent.From)),
            LatestIna = latestIna is null ? null : RuntimeInaSample.From(latestIna),
            VoltageWindow = RuntimeVoltageWindow.Empty.Append(
                voltage.Select(v => new RuntimeVoltageSample(v.OutletId, RuntimeTime.Normalize(v.Timestamp), v.Voltage)),
                RuntimeTime.Normalize(now)),
        };
    }
}
