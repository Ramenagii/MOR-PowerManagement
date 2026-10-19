using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.Runtime;

namespace Mor.PowerManagement.Infrastructure.Power;

public static class PowerRuntimeRegistration
{
    /// <summary>
    /// Registers the runtime hydrator and the single-writer identity. Nothing
    /// runs at registration; with <c>Telemetry:CachedReadsEnabled</c> off
    /// nothing runs at all.
    /// </summary>
    public static IServiceCollection AddPowerRuntime(this IServiceCollection services, string connectionString)
    {
        services.AddSingleton<IPowerRuntimeHydrator, PowerRuntimeHydrator>();
        services.AddSingleton(new PowerRuntimeWriterIdentity(SingleWriterGuard.IdentityFor(connectionString)));
        services.AddSingleton<PowerRuntimeWriterGuardHolder>();
        return services;
    }

    /// <summary>
    /// Startup, before database initialization: when cached reads are on,
    /// take the single-writer guard (or fail startup). Held until the host stops.
    /// </summary>
    public static void AcquirePowerRuntimeWriterGuard(this IHost host)
    {
        var options = host.Services.GetRequiredService<IOptions<PowerRuntimeOptions>>().Value;
        if (!options.CachedReadsEnabled)
        {
            return;
        }

        var identity = host.Services.GetRequiredService<PowerRuntimeWriterIdentity>();
        var holder = host.Services.GetRequiredService<PowerRuntimeWriterGuardHolder>();
        holder.Guard = SingleWriterGuard.Acquire(identity.Value, options.SingleWriterLockDirectory);

        host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopped.Register(holder.Dispose);
        host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(PowerRuntimeRegistration))
            .LogInformation("Runtime single-writer guard acquired for database identity {Identity}.", identity.Value);
    }

    /// <summary>
    /// Startup, after database initialization and before the host accepts
    /// requests: when cached reads are on, hydrate the runtime snapshot once.
    /// A failure stops startup rather than serving unsynchronized state.
    /// </summary>
    public static async Task HydratePowerRuntimeAsync(this IHost host, CancellationToken cancellationToken = default)
    {
        var store = host.Services.GetRequiredService<IPowerRuntimeStore>();
        if (!store.Enabled)
        {
            return;
        }

        var snapshot = await store.GetAsync(cancellationToken);
        host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(PowerRuntimeRegistration))
            .LogInformation("Runtime snapshot hydrated: {Outlets} outlets, {Events} recent events, {VoltageSamples} voltage samples.",
                snapshot.Outlets.Length, snapshot.RecentEvents.Length, snapshot.VoltageWindow.Samples.Length);
    }
}

public sealed record PowerRuntimeWriterIdentity(string Value);

public sealed class PowerRuntimeWriterGuardHolder : IDisposable
{
    public SingleWriterGuard? Guard { get; set; }

    public void Dispose() => Guard?.Dispose();
}
