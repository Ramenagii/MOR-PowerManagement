using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.Power;

public static class QuietDatabaseRegistration
{
    /// <summary>Aspire's EnrichNpgsqlDbContext adds a DbContext health check (one connection per /health call) unless this is true.</summary>
    public const string AspireDisableHealthChecksKey = "Aspire:Npgsql:EntityFrameworkCore:PostgreSQL:DisableHealthChecks";

    public const string AspireContextDisableHealthChecksKey =
        "Aspire:Npgsql:EntityFrameworkCore:PostgreSQL:" + nameof(ApplicationDbContext) + ":DisableHealthChecks";

    public const string LiveTag = "live";

    public const string ReadyTag = "ready";

    /// <summary>
    /// Call before <c>AddInfrastructureServices</c>. With
    /// <c>Telemetry:QuietDatabaseMode</c> off this only registers the option.
    /// On, it fails startup unless cached reads, runtime ingest and batch
    /// persistence are all on, turns off the Aspire DbContext health check and
    /// registers <see cref="QuietRuntimeReadinessCheck"/>, which reads memory only.
    /// </summary>
    public static QuietDatabaseOptions AddQuietDatabase(this IHostApplicationBuilder builder)
    {
        var quiet = QuietDatabaseOptions.FromConfiguration(builder.Configuration);
        builder.Services.AddSingleton(Options.Create(quiet));
        if (!quiet.Enabled)
        {
            return quiet;
        }

        QuietDatabasePolicy.Validate(
            quiet,
            PowerRuntimeOptions.FromConfiguration(builder.Configuration),
            HistoryPersistenceOptions.FromConfiguration(builder.Configuration));

        builder.Configuration.AddInMemoryCollection(
        [
            new(AspireDisableHealthChecksKey, "true"),
            new(AspireContextDisableHealthChecksKey, "true"),
        ]);
        builder.Services.AddHealthChecks()
            .AddCheck<QuietRuntimeReadinessCheck>(QuietRuntimeReadinessCheck.Name, tags: [ReadyTag]);
        return quiet;
    }

    /// <summary>
    /// Call after <c>Build()</c> and before any startup database work. Quiet
    /// mode only: rejects database health checks, health publishers and
    /// keepalive/pool-minimum connection settings. Opens no connection.
    /// </summary>
    public static void EnsureQuietDatabasePolicy(this IHost host)
    {
        var quiet = host.Services.GetRequiredService<IOptions<QuietDatabaseOptions>>().Value;
        if (!quiet.Enabled)
        {
            return;
        }

        var health = host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value;
        QuietDatabasePolicy.EnsureHealthChecks(
            health.Registrations.Select(r => r.Name),
            host.Services.GetServices<IHealthCheckPublisher>().Count());

        using (var scope = host.Services.CreateScope())
        {
            // GetConnectionString reads the configured string; it does not connect.
            var connectionString = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetConnectionString();
            QuietDatabasePolicy.EnsureConnectionString(connectionString ?? string.Empty);
        }

        host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(QuietDatabaseRegistration))
            .LogInformation("Quiet database mode on: health checks are in-process only; no keepalive or pool minimum.");
    }

    /// <summary>
    /// Quiet mode maps the health endpoints in every environment because they
    /// no longer touch the database. <c>/alive</c> is liveness (process only);
    /// <c>/health</c> adds runtime readiness. Platform restart probes belong on
    /// <c>/alive</c>: a restart discards buffered history.
    /// </summary>
    public static IEndpointRouteBuilder MapQuietDatabaseHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapHealthChecks("/health");
        endpoints.MapHealthChecks("/alive", new HealthCheckOptions
        {
            Predicate = r => r.Tags.Contains(LiveTag),
        });
        return endpoints;
    }
}

/// <summary>
/// Readiness from in-memory state only. Unhealthy (503) until the runtime
/// snapshot is hydrated and the history writer initialized, and while the
/// loss bound is breached or a dropped run is not yet recorded. Degraded (200)
/// for a recorded gap or a failed flush awaiting retry. Never queries.
/// </summary>
public sealed class QuietRuntimeReadinessCheck(IPowerRuntimeStore runtime, IHistoryBuffer history) : IHealthCheck
{
    public const string Name = "quiet-runtime";

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (runtime.Published is null)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("Runtime snapshot is not hydrated."));
        }

        var status = history.GetStatus();
        if (!status.Initialized)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("History writer is not initialized."));
        }

        var data = new Dictionary<string, object>
        {
            ["bufferedRows"] = status.BufferedRows,
            ["totalDroppedAcquisitions"] = status.TotalDroppedAcquisitions,
            ["consecutiveFlushFailures"] = status.ConsecutiveFlushFailures,
        };

        if (status.LossGuaranteeBreached)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("History loss bound exceeded.", data: data));
        }

        if (status.Gaps.Any(g => !g.Recorded))
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("History was dropped and the gap is not yet recorded.", data: data));
        }

        if (status.AcceptanceFailing)
        {
            // Only gaps already written to the history checkpoint remain; they persist across restarts.
            return Task.FromResult(HealthCheckResult.Degraded("A recorded history gap exists.", data: data));
        }

        if (status.ConsecutiveFlushFailures > 0)
        {
            return Task.FromResult(HealthCheckResult.Degraded("The last history flush failed; it will be retried.", data: data));
        }

        return Task.FromResult(HealthCheckResult.Healthy("Runtime hydrated; history writer initialized.", data));
    }
}
