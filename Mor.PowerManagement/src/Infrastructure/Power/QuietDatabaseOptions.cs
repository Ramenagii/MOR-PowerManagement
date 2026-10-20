using Microsoft.Extensions.Configuration;

namespace Mor.PowerManagement.Infrastructure.Power;

/// <summary>
/// <c>Telemetry:QuietDatabaseMode</c> (PLAN-0001 Spec G). Off by default; with
/// it off nothing changes in any environment. On, it removes the remaining
/// recurring database wake sources (health checks, keepalive, pool minimums)
/// and requires the cached-read, runtime-ingest and batch-persistence flags,
/// so an idle backend issues no SQL and Neon can suspend.
/// </summary>
public sealed class QuietDatabaseOptions
{
    public const string QuietDatabaseModeKey = "Telemetry:QuietDatabaseMode";

    public bool Enabled { get; init; }

    public static QuietDatabaseOptions FromConfiguration(IConfiguration configuration) => new()
    {
        Enabled = configuration.GetValue<bool>(QuietDatabaseModeKey),
    };
}
