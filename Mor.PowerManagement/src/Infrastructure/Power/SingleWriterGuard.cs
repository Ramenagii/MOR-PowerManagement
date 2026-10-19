using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace Mor.PowerManagement.Infrastructure.Power;

/// <summary>
/// Exclusive process guard for one rig/database identity on one host.
///
/// The runtime snapshot is only correct while a single backend process writes
/// the rig's state: a second writer's commits would never reach this process's
/// snapshot. The guard holds an OS-exclusive lock on a file named after the
/// database identity (host, port, database, search path; never credentials),
/// so a second backend process on the same host fails at startup instead of
/// running beside the first. The OS releases the lock when the process exits,
/// including on a crash.
///
/// This is NOT distributed fencing. Two hosts (or two containers with separate
/// temp directories) do not see each other's lock file. Deployments must be
/// stop-before-start with one active backend; any topology that can overlap
/// writers across hosts is an enablement blocker for cached reads. There is no
/// database lease and nothing is refreshed periodically.
/// </summary>
public sealed class SingleWriterGuard : IDisposable
{
    private FileStream? _lock;

    private SingleWriterGuard(FileStream lockStream, string identity, string lockPath)
    {
        _lock = lockStream;
        Identity = identity;
        LockPath = lockPath;
    }

    /// <summary>Hashed database identity this guard holds (no host names or credentials).</summary>
    public string Identity { get; }

    public string LockPath { get; }

    /// <summary>
    /// Derives the guard identity from a connection string. Only host, port,
    /// database and search path participate, hashed; the result is safe to log.
    /// </summary>
    public static string IdentityFor(string connectionString)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        var key = string.Join('|',
            (builder.Host ?? string.Empty).Trim().ToLowerInvariant(),
            builder.Port.ToString(System.Globalization.CultureInfo.InvariantCulture),
            builder.Database ?? string.Empty,
            builder.SearchPath ?? string.Empty);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
    }

    /// <summary>Acquires the guard or throws <see cref="SingleWriterGuardException"/> when another holder exists.</summary>
    public static SingleWriterGuard Acquire(string identity, string? directory = null)
    {
        var root = string.IsNullOrWhiteSpace(directory) ? Path.GetTempPath() : directory;
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, $"mor-power-runtime-{identity}.lock");

        try
        {
            // FileShare.None: Windows refuses a second open; on Unix .NET takes
            // an exclusive advisory lock (flock) that a second open cannot get.
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.None);
            stream.SetLength(0);
            var owner = Encoding.UTF8.GetBytes($"pid={Environment.ProcessId} acquired={DateTimeOffset.UtcNow:O}\n");
            stream.Write(owner);
            stream.Flush(flushToDisk: true);
            return new SingleWriterGuard(stream, identity, path);
        }
        catch (IOException ex)
        {
            throw new SingleWriterGuardException(
                $"Another backend process on this host already holds the runtime writer guard for database identity {identity}. " +
                "Cached reads require exactly one active backend: stop the running instance before starting another.", ex);
        }
    }

    public void Dispose()
    {
        var stream = Interlocked.Exchange(ref _lock, null);
        stream?.Dispose();
    }
}

public sealed class SingleWriterGuardException(string message, Exception inner) : InvalidOperationException(message, inner);
