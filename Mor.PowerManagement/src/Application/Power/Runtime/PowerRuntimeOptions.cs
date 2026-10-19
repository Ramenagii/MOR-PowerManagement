using Microsoft.Extensions.Configuration;

namespace Mor.PowerManagement.Application.Power.Runtime;

/// <summary>
/// PLAN-0001 Spec D settings. Everything defaults OFF, including when the
/// configuration key is absent: the disabled path is the legacy
/// database-per-request implementation.
/// </summary>
public sealed class PowerRuntimeOptions
{
    public const string CachedReadsEnabledKey = "Telemetry:CachedReadsEnabled";

    public const string SingleWriterLockDirectoryKey = "Telemetry:SingleWriterLockDirectory";

    /// <summary>
    /// <c>Telemetry:CachedReadsEnabled</c>. When true, device configuration and
    /// dashboard current state are served from the hydrated runtime snapshot,
    /// Power mutations are serialized, and durable changes are published to the
    /// snapshot only after their transaction commits.
    /// </summary>
    public bool CachedReadsEnabled { get; set; }

    /// <summary>
    /// Directory for the single-writer process guard's lock file. Null means
    /// the process temp directory. It must be a directory every backend
    /// process on the host resolves identically.
    /// </summary>
    public string? SingleWriterLockDirectory { get; set; }

    public static PowerRuntimeOptions FromConfiguration(IConfiguration configuration) => new()
    {
        CachedReadsEnabled = configuration.GetValue<bool>(CachedReadsEnabledKey),
        SingleWriterLockDirectory = configuration[SingleWriterLockDirectoryKey],
    };
}
