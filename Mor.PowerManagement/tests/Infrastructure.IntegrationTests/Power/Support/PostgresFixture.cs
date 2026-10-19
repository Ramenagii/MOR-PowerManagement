using System.Net;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mor.PowerManagement.Infrastructure.Data;
using Npgsql;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

/// <summary>
/// Standalone PostgreSQL harness for PLAN-0001 integration tests.
///
/// Reads <c>MOR_TEST_DB_CONNECTION</c> from the process environment, creates a
/// uniquely named schema, proves the session resolves only to that schema,
/// applies the application's migrations into it (migration history included),
/// and drops only that schema on disposal. It never starts Aspire, never runs
/// the application seeder, and never calls a database-wide
/// <c>EnsureDeleted</c>.
///
/// A missing or unusable test database is a FAILURE, not a skip: missing
/// infrastructure is not a passing integration result.
///
/// The connection string is never written to output or exception text; only
/// host, port and database name are reported.
/// </summary>
public sealed partial class PostgresFixture : IAsyncDisposable
{
    public const string ConnectionEnvironmentVariable = "MOR_TEST_DB_CONNECTION";

    public const string SchemaPrefix = "mor_ct_";

    // Tables the application migrations must create inside the schema.
    private static readonly string[] RequiredTables =
    {
        "__EFMigrationsHistory",
        "Outlets",
        "PowerSystemConfigs",
        "PowerEvents",
        "TelemetryReadings",
        "InaReadings",
        "ControlPolicies",
        "TelemetryReadingRollups",
        "AspNetUsers",
    };

    private readonly string _serverConnectionString;
    private readonly List<string> _isolationEvidence = new();
    private bool _schemaCreated;
    private bool _disposed;

    private PostgresFixture(string serverConnectionString, string schemaName, string schemaConnectionString, string target)
    {
        _serverConnectionString = serverConnectionString;
        SchemaName = schemaName;
        ConnectionString = schemaConnectionString;
        Target = target;
    }

    /// <summary>The isolated schema owned by this fixture instance.</summary>
    public string SchemaName { get; }

    /// <summary>Connection string whose search_path is ONLY <see cref="SchemaName"/>. Never print it.</summary>
    public string ConnectionString { get; }

    /// <summary>Non-secret description of the target: host:port/database.</summary>
    public string Target { get; }

    /// <summary>Human-readable record of every isolation check this fixture performed.</summary>
    public IReadOnlyList<string> IsolationEvidence => _isolationEvidence;

    /// <summary>Migrations applied into <see cref="SchemaName"/>, in order.</summary>
    public IReadOnlyList<string> AppliedMigrations { get; private set; } = Array.Empty<string>();

    public static async Task<PostgresFixture> CreateAsync(CancellationToken cancellationToken = default)
    {
        var raw = Environment.GetEnvironmentVariable(ConnectionEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new InvalidOperationException(
                $"{ConnectionEnvironmentVariable} is not set. PLAN-0001 integration tests require a local throwaway PostgreSQL " +
                "database (see tests/Infrastructure.IntegrationTests/Power/ControlCharacterization.md). " +
                "This is a test FAILURE, not a skip: missing infrastructure is not a passing integration result.");
        }

        var server = ParseAndGuard(raw);
        var target = $"{server.Host}:{server.Port}/{server.Database}";
        var schemaName = $"{SchemaPrefix}{DateTime.UtcNow:yyyyMMddHHmmss}_{Guid.NewGuid():N}"[..(SchemaPrefix.Length + 14 + 1 + 8)];

        var scoped = new NpgsqlConnectionStringBuilder(server.ConnectionString)
        {
            SearchPath = schemaName,
            // Separate, short-lived pool per fixture so a dropped schema can
            // never be reached through a recycled connection.
            ApplicationName = $"mor-integration-{schemaName}",
        };

        var fixture = new PostgresFixture(server.ConnectionString, schemaName, scoped.ConnectionString, target);
        try
        {
            await fixture.InitializeAsync(cancellationToken);
        }
        catch
        {
            await fixture.DisposeAsync();
            throw;
        }

        return fixture;
    }

    private static NpgsqlConnectionStringBuilder ParseAndGuard(string raw)
    {
        if (raw.Contains("://", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"{ConnectionEnvironmentVariable} must use keyword form (Host=...;Port=...;Username=...;Password=...;Database=...), not a URL.");
        }

        NpgsqlConnectionStringBuilder builder;
        try
        {
            builder = new NpgsqlConnectionStringBuilder(raw);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException or KeyNotFoundException)
        {
            // Do not chain the exception: its message can quote the input.
            throw new InvalidOperationException($"{ConnectionEnvironmentVariable} is not a valid Npgsql connection string.");
        }

        var host = builder.Host ?? string.Empty;
        var loopback = host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || (IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));
        if (!loopback || host.Contains(',', StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"{ConnectionEnvironmentVariable} must point at a local loopback PostgreSQL (127.0.0.1, ::1 or localhost); " +
                $"refusing host '{host}'. Integration tests never run against Neon, LoadWise or production.");
        }

        if (string.IsNullOrWhiteSpace(builder.Database))
        {
            throw new InvalidOperationException($"{ConnectionEnvironmentVariable} must name a Database.");
        }

        builder.SearchPath = null;
        return builder;
    }

    private async Task InitializeAsync(CancellationToken cancellationToken)
    {
        GuardSchemaName(SchemaName);

        await using (var server = await OpenServerAsync(cancellationToken))
        {
            var exists = await ScalarAsync<long>(server, "SELECT count(*) FROM pg_namespace WHERE nspname = @schema", cancellationToken);
            if (exists != 0)
            {
                throw new InvalidOperationException($"Schema {SchemaName} already exists; refusing to reuse it.");
            }

            await ExecuteAsync(server, $"CREATE SCHEMA \"{SchemaName}\"", cancellationToken);
            _schemaCreated = true;
            _isolationEvidence.Add($"created schema {SchemaName} on {Target}");
        }

        var outsideBefore = await SnapshotOutsideRelationsAsync(cancellationToken);

        // ---- Isolation proof BEFORE any migration runs.
        await using (var scoped = await OpenScopedAsync(cancellationToken))
        {
            var currentSchema = await ScalarAsync<string?>(scoped, "SELECT current_schema()", cancellationToken);
            var schemas = await ScalarAsync<string[]>(scoped, "SELECT current_schemas(false)", cancellationToken);
            if (currentSchema != SchemaName || schemas is null || schemas.Length != 1 || schemas[0] != SchemaName)
            {
                throw new InvalidOperationException(
                    $"Isolation check failed: session resolves to current_schema={currentSchema ?? "<null>"}, " +
                    $"current_schemas=[{string.Join(", ", schemas ?? Array.Empty<string>())}], expected only {SchemaName}.");
            }

            var relations = await ScalarAsync<long>(scoped,
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = @schema",
                cancellationToken);
            if (relations != 0)
            {
                throw new InvalidOperationException($"Isolation check failed: new schema {SchemaName} already holds {relations} relation(s).");
            }

            _isolationEvidence.Add($"pre-migration: current_schema()={currentSchema}; current_schemas(false)=[{string.Join(", ", schemas)}]; relations in schema=0");
        }

        // ---- Migrations, with the history table pinned to the schema.
        await using (var context = CreateMigrationContext())
        {
            await context.Database.MigrateAsync(cancellationToken);
            AppliedMigrations = (await context.Database.GetAppliedMigrationsAsync(cancellationToken)).ToList();
            var known = context.Database.GetMigrations().ToList();
            if (!AppliedMigrations.SequenceEqual(known))
            {
                throw new InvalidOperationException(
                    $"Migration history in {SchemaName} does not match the assembly: applied {AppliedMigrations.Count}, known {known.Count}.");
            }
        }

        // ---- Isolation proof AFTER migration.
        await using (var scoped = await OpenScopedAsync(cancellationToken))
        {
            var tables = new List<string>();
            await using (var command = new NpgsqlCommand("SELECT tablename FROM pg_tables WHERE schemaname = @schema ORDER BY tablename", scoped))
            {
                command.Parameters.AddWithValue("schema", SchemaName);
                await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    tables.Add(reader.GetString(0));
                }
            }

            var missing = RequiredTables.Except(tables, StringComparer.Ordinal).ToList();
            if (missing.Count > 0)
            {
                throw new InvalidOperationException($"Migration did not create [{string.Join(", ", missing)}] inside {SchemaName}.");
            }

            // Raw-SQL objects (the TelemetryReadingRollups table, the BRIN index)
            // and unqualified runtime SQL must resolve to this schema.
            var rollupSchema = await ScalarAsync<string>(scoped,
                "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = '\"TelemetryReadingRollups\"'::regclass",
                cancellationToken);
            var brinSchema = await ScalarAsync<string>(scoped,
                "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = '\"IX_TelemetryReadings_Timestamp_brin\"'::regclass",
                cancellationToken);
            if (rollupSchema != SchemaName || brinSchema != SchemaName)
            {
                throw new InvalidOperationException($"Raw-SQL objects resolved outside {SchemaName} (rollups={rollupSchema}, brin={brinSchema}).");
            }

            _isolationEvidence.Add(
                $"post-migration: {tables.Count} tables in {SchemaName} (incl. __EFMigrationsHistory with {AppliedMigrations.Count} rows); " +
                $"raw-SQL TelemetryReadingRollups and BRIN index resolve to {rollupSchema}");
        }

        var outsideAfter = await SnapshotOutsideRelationsAsync(cancellationToken);
        if (!outsideBefore.SetEquals(outsideAfter))
        {
            var added = outsideAfter.Except(outsideBefore).Take(10);
            var removed = outsideBefore.Except(outsideAfter).Take(10);
            throw new InvalidOperationException(
                $"Isolation check failed: relations outside {SchemaPrefix}* schemas changed during migration " +
                $"(added [{string.Join(", ", added)}], removed [{string.Join(", ", removed)}]).");
        }

        _isolationEvidence.Add($"outside-schema relation inventory unchanged by migration ({outsideBefore.Count} relations)");
    }

    /// <summary>A fresh context bound to the isolated schema (no interceptors).</summary>
    public ApplicationDbContext CreateMigrationContext()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseNpgsql(ConnectionString, npgsql => npgsql.MigrationsHistoryTable("__EFMigrationsHistory", SchemaName))
            .ConfigureWarnings(warnings => warnings.Ignore(RelationalEventId.PendingModelChangesWarning))
            .Options;
        return new ApplicationDbContext(options);
    }

    /// <summary>
    /// Removes all rows from this schema's tables (never the migration
    /// history) so each test starts from an empty, migrated schema. Every
    /// statement is schema-qualified with <see cref="SchemaName"/>.
    /// </summary>
    public async Task ResetAsync(CancellationToken cancellationToken = default)
    {
        GuardSchemaName(SchemaName);
        await using var scoped = await OpenScopedAsync(cancellationToken);

        var tables = new List<string>();
        await using (var command = new NpgsqlCommand(
            "SELECT tablename FROM pg_tables WHERE schemaname = @schema AND tablename <> '__EFMigrationsHistory' ORDER BY tablename", scoped))
        {
            command.Parameters.AddWithValue("schema", SchemaName);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                tables.Add(reader.GetString(0));
            }
        }

        if (tables.Count == 0)
        {
            return;
        }

        var qualified = string.Join(", ", tables.Select(t => $"\"{SchemaName}\".\"{t.Replace("\"", "\"\"", StringComparison.Ordinal)}\""));
        // Every table in this schema is listed together. Omitting CASCADE makes
        // a cross-schema foreign key fail rather than truncate another owner.
        await ExecuteAsync(scoped, $"TRUNCATE TABLE {qualified} RESTART IDENTITY", cancellationToken);
    }

    /// <summary>Relations outside every <c>mor_ct_*</c> test schema and the system catalogs.</summary>
    public async Task<HashSet<string>> SnapshotOutsideRelationsAsync(CancellationToken cancellationToken = default)
    {
        await using var server = await OpenServerAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT LIKE 'mor\_ct\_%'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg\_toast%'
              AND n.nspname NOT LIKE 'pg\_temp%'
            """, server);
        var result = new HashSet<string>(StringComparer.Ordinal);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            result.Add(reader.GetString(0));
        }

        return result;
    }

    public async Task<bool> SchemaExistsAsync(CancellationToken cancellationToken = default)
    {
        await using var server = await OpenServerAsync(cancellationToken);
        return await ScalarAsync<long>(server, "SELECT count(*) FROM pg_namespace WHERE nspname = @schema", cancellationToken) == 1;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        NpgsqlConnection.ClearPool(new NpgsqlConnection(ConnectionString));

        if (!_schemaCreated)
        {
            return;
        }

        // Teardown is limited to the schema this instance created.
        GuardSchemaName(SchemaName);
        await using var server = await OpenServerAsync(CancellationToken.None);
        await ExecuteAsync(server, $"DROP SCHEMA \"{SchemaName}\" CASCADE", CancellationToken.None);
        _isolationEvidence.Add($"dropped schema {SchemaName}");
    }

    private async Task<NpgsqlConnection> OpenServerAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(_serverConnectionString);
        try
        {
            await connection.OpenAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is NpgsqlException or System.Net.Sockets.SocketException or TimeoutException)
        {
            await connection.DisposeAsync();
            throw new InvalidOperationException(
                $"Cannot open the integration-test database at {Target} ({ex.GetType().Name}). " +
                "Start the local throwaway PostgreSQL container; this is a test FAILURE, not a skip.");
        }

        return connection;
    }

    private async Task<NpgsqlConnection> OpenScopedAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(ConnectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private async Task<T> ScalarAsync<T>(NpgsqlConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        if (sql.Contains("@schema", StringComparison.Ordinal))
        {
            command.Parameters.AddWithValue("schema", SchemaName);
        }

        var value = await command.ExecuteScalarAsync(cancellationToken);
        return value is DBNull or null ? default! : (T)value;
    }

    private static async Task ExecuteAsync(NpgsqlConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void GuardSchemaName(string schemaName)
    {
        if (!SchemaNamePattern().IsMatch(schemaName))
        {
            throw new InvalidOperationException($"Refusing to operate on schema '{schemaName}': not a fixture-owned {SchemaPrefix}* name.");
        }
    }

    [GeneratedRegex("^mor_ct_[0-9]{14}_[0-9a-f]{8}$")]
    private static partial Regex SchemaNamePattern();
}
