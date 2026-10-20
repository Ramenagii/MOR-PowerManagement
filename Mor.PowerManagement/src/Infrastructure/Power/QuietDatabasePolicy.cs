using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Runtime;
using Npgsql;

namespace Mor.PowerManagement.Infrastructure.Power;

/// <summary>
/// Startup rules for <see cref="QuietDatabaseOptions"/>. Every check is static
/// inspection of configuration or registrations; none opens a connection.
/// Failure messages name keys and registrations only, never values, so a
/// connection string never reaches a log.
/// </summary>
public static class QuietDatabasePolicy
{
    /// <summary>The only health checks quiet mode allows: the in-process liveness check and the runtime readiness check.</summary>
    public static readonly IReadOnlySet<string> AllowedHealthChecks =
        new HashSet<string>(StringComparer.Ordinal) { "self", QuietRuntimeReadinessCheck.Name };

    /// <summary>Quiet mode is only valid with all three runtime flags on; any other combination fails startup.</summary>
    public static void Validate(QuietDatabaseOptions quiet, PowerRuntimeOptions runtime, HistoryPersistenceOptions history)
    {
        if (!quiet.Enabled)
        {
            return;
        }

        var missing = new List<string>();
        if (!runtime.CachedReadsEnabled) missing.Add(PowerRuntimeOptions.CachedReadsEnabledKey);
        if (!history.RuntimeIngestEnabled) missing.Add(HistoryPersistenceOptions.RuntimeIngestEnabledKey);
        if (!history.BatchPersistenceEnabled) missing.Add(HistoryPersistenceOptions.BatchPersistenceEnabledKey);
        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"{QuietDatabaseOptions.QuietDatabaseModeKey}=true requires {string.Join(", ", missing.Select(k => k + "=true"))}.");
        }
    }

    /// <summary>
    /// Connection-string settings that would keep a physical connection open
    /// or send traffic while the backend is idle. Returns keyword names only.
    /// Npgsql defaults (Keepalive=0, TCP Keepalive=false, Minimum Pool Size=0)
    /// produce no findings.
    /// </summary>
    public static IReadOnlyList<string> ConnectionFindings(string connectionString)
    {
        var settings = new NpgsqlConnectionStringBuilder(connectionString);
        var findings = new List<string>();
        if (settings.KeepAlive > 0) findings.Add("Keepalive");
        if (settings.TcpKeepAlive) findings.Add("TCP Keepalive");
        if (settings.MinPoolSize > 0) findings.Add("Minimum Pool Size");
        return findings;
    }

    public static void EnsureConnectionString(string connectionString)
    {
        var findings = ConnectionFindings(connectionString);
        if (findings.Count > 0)
        {
            throw new InvalidOperationException(
                $"{QuietDatabaseOptions.QuietDatabaseModeKey}=true does not allow these connection-string settings: {string.Join(", ", findings)}. " +
                "Remove them (Npgsql defaults are quiet).");
        }
    }

    /// <summary>Rejects any health check that is not in-process, and any periodic health publisher.</summary>
    public static void EnsureHealthChecks(IEnumerable<string> registeredChecks, int publisherCount)
    {
        var disallowed = registeredChecks.Where(name => !AllowedHealthChecks.Contains(name)).ToList();
        if (disallowed.Count > 0)
        {
            throw new InvalidOperationException(
                $"{QuietDatabaseOptions.QuietDatabaseModeKey}=true allows only in-process health checks; remove: {string.Join(", ", disallowed)}.");
        }

        if (publisherCount > 0)
        {
            throw new InvalidOperationException(
                $"{QuietDatabaseOptions.QuietDatabaseModeKey}=true does not allow periodic health-check publishers ({publisherCount} registered).");
        }
    }
}
