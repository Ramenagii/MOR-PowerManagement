using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.Power.History;

public static class HistoryPersistenceRegistration
{
    public static IServiceCollection AddHistoryPersistence(this IServiceCollection services)
    {
        services.AddSingleton<BoundedHistoryBuffer>();
        services.AddSingleton<IHistoryBuffer>(sp => sp.GetRequiredService<BoundedHistoryBuffer>());
        services.AddSingleton<TelemetryBulkWriter>();
        services.AddSingleton<BatchWindowCoordinator>();
        services.AddHostedService(sp => sp.GetRequiredService<BatchWindowCoordinator>());
        services.AddSingleton<IHistoryMaintenance, LegacyHistoryMaintenance>();
        return services;
    }

    public static Task InitializeHistoryPersistenceAsync(this IHost host, CancellationToken token = default)
        => host.Services.GetRequiredService<BatchWindowCoordinator>().InitializeAsync(token);
}

/// <summary>F replaces the retention algorithm. E only moves it into shared wake windows.</summary>
internal sealed class LegacyHistoryMaintenance(TelemetryRetentionService retention) : IHistoryMaintenance
{
    public string Name => "legacy-retention";
    public Task RunAsync(HistoryMaintenanceWindow window, CancellationToken cancellationToken)
        => retention.PruneAsync(cancellationToken);
}
