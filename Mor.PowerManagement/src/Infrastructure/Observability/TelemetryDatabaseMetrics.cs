using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Mor.PowerManagement.Infrastructure.Observability;

/// <summary>
/// Bounded set of activity categories every database command and HTTP request
/// is attributed to (PLAN-0001 Spec A). The set is fixed on purpose: a label
/// that could be derived from request data would make metric cardinality
/// depend on traffic.
/// </summary>
public enum TelemetryActivityCategory
{
    // Work that no scope or SQL fingerprint explains. Reported, never hidden.
    Unattributed = 0,

    // Migrations, seeding and runtime hydration before the host serves traffic.
    Startup,

    // GET /api/Device/config, polled by the ESP32 every 500 ms.
    DeviceConfiguration,

    // POST /api/Device/telemetry and the dashboard scenario ingest, which run
    // the same IngestTelemetry command.
    TelemetryIngest,

    // GET /api/Dashboard/state, polled by each open console every 2 s.
    DashboardCurrentState,

    // GET /api/Dashboard/telemetry chart/inventory series.
    History,

    // Every other /api/Dashboard route: commands, policy/threshold edits and
    // the policies read.
    AdministratorControl,

    // /api/Users (login/manage) and any command touching an ASP.NET Identity
    // table, which includes cookie security-stamp validation that runs in the
    // authentication middleware before any request scope exists.
    Authentication,

    // Retention, rollups, checkpoints and bulk history persistence.
    RetentionBulk,

    // /health and /alive.
    HealthChecks,
}

public enum TelemetryCommandKind
{
    Reader,
    Scalar,
    NonQuery,
}

public static class TelemetryActivityCategories
{
    public static IReadOnlyList<TelemetryActivityCategory> All { get; } = Enum.GetValues<TelemetryActivityCategory>();

    public static string Label(TelemetryActivityCategory category) => category switch
    {
        TelemetryActivityCategory.Startup => "startup",
        TelemetryActivityCategory.DeviceConfiguration => "device-config",
        TelemetryActivityCategory.TelemetryIngest => "telemetry-ingest",
        TelemetryActivityCategory.DashboardCurrentState => "dashboard-current-state",
        TelemetryActivityCategory.History => "history",
        TelemetryActivityCategory.AdministratorControl => "admin-control",
        TelemetryActivityCategory.Authentication => "authentication",
        TelemetryActivityCategory.RetentionBulk => "retention-bulk",
        TelemetryActivityCategory.HealthChecks => "health-checks",
        _ => "unattributed",
    };

    // Background categories are explicit scopes for work no request owns. They
    // win over the Identity-table fingerprint, so seeding the administrator at
    // startup is startup work rather than authentication traffic.
    public static bool IsBackground(TelemetryActivityCategory category)
        => category is TelemetryActivityCategory.Startup or TelemetryActivityCategory.RetentionBulk;

    /// <summary>
    /// Maps a request path to its category. Only the path is inspected: query
    /// strings, headers and bodies never influence the label.
    /// </summary>
    public static TelemetryActivityCategory FromRequestPath(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return TelemetryActivityCategory.Unattributed;
        }

        if (IsUnder(path, "/api/Device/config")) return TelemetryActivityCategory.DeviceConfiguration;
        if (IsUnder(path, "/api/Device/telemetry")) return TelemetryActivityCategory.TelemetryIngest;
        if (IsUnder(path, "/api/Dashboard/scenarios/ingest")) return TelemetryActivityCategory.TelemetryIngest;
        if (IsUnder(path, "/api/Dashboard/state")) return TelemetryActivityCategory.DashboardCurrentState;
        if (IsUnder(path, "/api/Dashboard/telemetry")) return TelemetryActivityCategory.History;
        if (IsUnder(path, "/api/Dashboard")) return TelemetryActivityCategory.AdministratorControl;
        if (IsUnder(path, "/api/Users")) return TelemetryActivityCategory.Authentication;
        if (IsUnder(path, "/health") || IsUnder(path, "/alive")) return TelemetryActivityCategory.HealthChecks;

        return TelemetryActivityCategory.Unattributed;
    }

    private static bool IsUnder(string path, string prefix)
        => path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && (path.Length == prefix.Length || path[prefix.Length] == '/');
}

/// <summary>
/// Ambient attribution scope. Later workers wrap background work in
/// <c>using var scope = TelemetryActivityScope.Begin(...)</c>; the scope flows
/// with the async context into every database command the work issues.
///
/// Setting a scope is a no-op for the database: with measurement disabled
/// nothing reads it, so callers do not need to check the flag.
/// </summary>
public sealed class TelemetryActivityScope : IDisposable
{
    private static readonly AsyncLocal<TelemetryActivityScope?> CurrentScope = new();

    private readonly TelemetryActivityScope? _parent;
    private long _databaseCommands;
    private long _estimatedResultBytes;
    private bool _disposed;

    private TelemetryActivityScope(TelemetryActivityCategory category, string? routeLabel, TelemetryActivityScope? parent)
    {
        Category = category;
        RouteLabel = routeLabel;
        _parent = parent;
    }

    public static TelemetryActivityScope? Current => CurrentScope.Value;

    public TelemetryActivityCategory Category { get; }

    // Bounded route template (never the raw path) for request scopes.
    public string? RouteLabel { get; }

    // Commands attempted while this scope was current, whatever category each
    // command finally resolved to. Lets a request's HTTP figures be reconciled
    // with the database commands it caused.
    public long DatabaseCommands => Interlocked.Read(ref _databaseCommands);

    public long EstimatedResultBytes => Interlocked.Read(ref _estimatedResultBytes);

    public static TelemetryActivityScope Begin(TelemetryActivityCategory category, string? routeLabel = null)
    {
        var scope = new TelemetryActivityScope(category, routeLabel, CurrentScope.Value);
        CurrentScope.Value = scope;
        return scope;
    }

    internal void AddCommand() => Interlocked.Increment(ref _databaseCommands);

    internal void AddResultBytes(long bytes) => Interlocked.Add(ref _estimatedResultBytes, bytes);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (ReferenceEquals(CurrentScope.Value, this))
        {
            CurrentScope.Value = _parent;
        }
    }
}

/// <summary>
/// Sanitized, bounded description of a SQL command: statement verbs, the
/// tables touched and a short hash of the normalized text. Literals,
/// parameters and VALUES/IN lists are removed before hashing, so the label
/// never carries data and does not vary with batch size.
/// </summary>
public sealed record TelemetrySqlShape(string Label, bool TouchesIdentity, IReadOnlyList<TelemetrySqlStatement> Statements);

public sealed record TelemetrySqlStatement(string Verb, bool HasReturning, int ReturningColumns);

public static partial class TelemetrySqlFingerprint
{
    public const int MaxLabelLength = 96;
    private const int MaxTablesInLabel = 4;
    public static TelemetrySqlShape Describe(string? sql)
        => string.IsNullOrWhiteSpace(sql)
            ? new TelemetrySqlShape("(empty)", false, Array.Empty<TelemetrySqlStatement>())
            : Compute(sql);

    public static string Normalize(string sql)
    {
        var text = LineComment().Replace(sql, " ");
        text = BlockComment().Replace(text, " ");
        text = DollarQuoted().Replace(text, "?");
        text = StringLiteral().Replace(text, "?");
        text = Parameter().Replace(text, "?");
        text = NumericLiteral().Replace(text, "?");
        text = PlaceholderList().Replace(text, "(?)");
        text = RepeatedTuples().Replace(text, "(?)");
        text = Whitespace().Replace(text, " ");
        return text.Trim();
    }

    private static TelemetrySqlShape Compute(string sql)
    {
        var normalized = Normalize(sql);
        var statements = normalized
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();

        // EF batches repeat the same INSERT/UPDATE once per row; one distinct
        // shape per statement keeps the hash stable across batch sizes.
        var distinct = statements.Distinct(StringComparer.Ordinal).ToList();

        var verbs = new List<string>();
        var tables = new SortedSet<string>(StringComparer.Ordinal);
        var touchesIdentity = false;

        foreach (var statement in distinct)
        {
            var verb = LeadingVerb(statement);
            if (!verbs.Contains(verb))
            {
                verbs.Add(verb);
            }

            var cteNames = CteName().Matches(statement)
                .Select(m => m.Groups["name"].Value)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (Match match in TableReference().Matches(statement))
            {
                var name = match.Groups["table"].Value.Trim('"');
                if (cteNames.Contains(name))
                {
                    continue;
                }

                tables.Add(name.StartsWith("AspNet", StringComparison.Ordinal) ? "Identity" : "application");
                touchesIdentity |= name.StartsWith("AspNet", StringComparison.Ordinal);
            }
        }

        var shapes = statements
            .Select(s => new TelemetrySqlStatement(LeadingVerb(s), ReturningClause().IsMatch(s), CountReturningColumns(s)))
            .ToList();

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', distinct))))[..8].ToLowerInvariant();
        var tableText = string.Join(',', tables.Take(MaxTablesInLabel));
        if (tables.Count > MaxTablesInLabel)
        {
            tableText += $"+{tables.Count - MaxTablesInLabel}";
        }

        var verbText = string.Join('+', verbs.Take(3));
        var label = tableText.Length == 0 ? $"{verbText} #{hash}" : $"{verbText} {tableText} #{hash}";
        if (label.Length > MaxLabelLength)
        {
            label = label[..(MaxLabelLength - 10)] + $"… #{hash}";
        }

        return new TelemetrySqlShape(label, touchesIdentity, shapes);
    }

    private static string LeadingVerb(string statement)
    {
        var match = LeadingWord().Match(statement);
        var word = match.Value.ToUpperInvariant();
        return word is "SELECT" or "INSERT" or "UPDATE" or "DELETE" or "WITH" or "CREATE" or "ALTER" or "DROP" ? word : "OTHER";
    }

    private static int CountReturningColumns(string statement)
    {
        var match = ReturningClause().Match(statement);
        if (!match.Success)
        {
            return 0;
        }

        var tail = statement[(match.Index + match.Length)..];
        var depth = 0;
        var columns = 1;
        foreach (var c in tail)
        {
            if (c == '(') depth++;
            else if (c == ')') depth--;
            else if (c == ',' && depth == 0) columns++;
        }

        return columns;
    }

    [GeneratedRegex(@"--[^\r\n]*")]
    private static partial Regex LineComment();

    [GeneratedRegex(@"/\*.*?\*/", RegexOptions.Singleline)]
    private static partial Regex BlockComment();

    [GeneratedRegex(@"\$(?<tag>[A-Za-z_]*)\$.*?\$\k<tag>\$", RegexOptions.Singleline)]
    private static partial Regex DollarQuoted();

    [GeneratedRegex(@"[Ee]?'(?:[^']|'')*'")]
    private static partial Regex StringLiteral();

    [GeneratedRegex(@"@[A-Za-z_][A-Za-z0-9_]*|\$\d+")]
    private static partial Regex Parameter();

    [GeneratedRegex(@"(?<![A-Za-z_""])\b\d+(?:\.\d+)?\b")]
    private static partial Regex NumericLiteral();

    [GeneratedRegex(@"\(\s*\?(?:\s*,\s*\?)*\s*\)")]
    private static partial Regex PlaceholderList();

    [GeneratedRegex(@"\(\?\)(?:\s*,\s*\(\?\))+")]
    private static partial Regex RepeatedTuples();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"^[A-Za-z]+")]
    private static partial Regex LeadingWord();

    [GeneratedRegex(@"\bRETURNING\b", RegexOptions.IgnoreCase)]
    private static partial Regex ReturningClause();

    [GeneratedRegex(@"(?:\bWITH\b|,)\s*(?:RECURSIVE\s+)?""?(?<name>[A-Za-z_][A-Za-z0-9_]*)""?\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(", RegexOptions.IgnoreCase)]
    private static partial Regex CteName();

    [GeneratedRegex(@"\b(?:FROM|JOIN|INTO|UPDATE|TABLE|USING)\s+(?:ONLY\s+|IF\s+(?:NOT\s+)?EXISTS\s+)?(?:""?[A-Za-z_][A-Za-z0-9_$]*""?\.)?(?<table>""[^""]+""|[A-Za-z_][A-Za-z0-9_$]*)", RegexOptions.IgnoreCase)]
    private static partial Regex TableReference();
}

public sealed record TelemetryCommandStats(
    TelemetryActivityCategory Category,
    string Fingerprint,
    long Attempts,
    long Succeeded,
    long Failed,
    long Canceled,
    long ReaderCommands,
    long ScalarCommands,
    long NonQueryCommands,
    long RowsReturned,
    long ReaderReadCalls,
    long RowsAffected,
    long EstimatedResultBytes,
    double ExecutionMilliseconds,
    double MaxExecutionMilliseconds,
    double ReaderOpenMilliseconds)
{
    public long InFlight => Attempts - Succeeded - Failed - Canceled;
}

public sealed record TelemetryCategoryStats(
    TelemetryActivityCategory Category,
    long Attempts,
    long Succeeded,
    long Failed,
    long Canceled,
    long Retries,
    long RowsReturned,
    long RowsAffected,
    long EstimatedResultBytes,
    long ConnectionOpens,
    long ConnectionFailures,
    double ExecutionMilliseconds)
{
    public string Label => TelemetryActivityCategories.Label(Category);
}

public sealed record TelemetryHttpRouteStats(
    string Route,
    TelemetryActivityCategory Category,
    long Requests,
    long ServerErrors,
    long ResponseBodyBytes,
    long DatabaseCommands,
    long EstimatedDatabaseResultBytes);

/// <summary>
/// Point-in-time copy of every counter. Database result estimates and HTTP
/// response bytes are deliberately separate collections: neither is Neon
/// network transfer, and they must never be added together as if they were.
/// </summary>
public sealed record TelemetryMeasurementReport(
    DateTimeOffset CapturedAtUtc,
    long TotalCommandAttempts,
    long OverflowedFingerprints,
    IReadOnlyList<TelemetryCategoryStats> Categories,
    IReadOnlyList<TelemetryCommandStats> Commands,
    IReadOnlyList<TelemetryHttpRouteStats> HttpRoutes)
{
    public const string TransferDisclaimer =
        "Estimated database result bytes are row counts multiplied by a per-command width estimated from column metadata; they are not Neon network transfer. " +
        "Reader rows are EF Read() calls, an upper bound that includes one terminating call per fully enumerated result set. " +
        "HTTP response body bytes are backend-to-browser traffic, measured separately. " +
        "pg_stat_statements supplies calls, rows and timing, not network egress.";

    public long CategoryAttemptTotal => Categories.Sum(c => c.Attempts);

    public bool Reconciles => CategoryAttemptTotal == TotalCommandAttempts
        && Commands.Sum(c => c.Attempts) == TotalCommandAttempts;

    public TelemetryCategoryStats For(TelemetryActivityCategory category)
        => Categories.Single(c => c.Category == category);

    public long TotalEstimatedDatabaseResultBytes => Categories.Sum(c => c.EstimatedResultBytes);

    public long TotalHttpResponseBodyBytes => HttpRoutes.Sum(r => r.ResponseBodyBytes);
}

/// <summary>
/// In-process accumulator for the measurement interceptors and request
/// middleware. Registered only when <c>Telemetry:Measurement:Enabled</c> is
/// true. It never touches the database and starts no timers.
/// </summary>
public sealed class TelemetryDatabaseMetrics : IDisposable
{
    public const string MeterName = "Mor.PowerManagement.Telemetry.Measurement";
    public const int MaxCommandKeys = 256;
    public const int MaxRouteKeys = 64;
    public const string OverflowLabel = "(overflow)";

    private readonly ConcurrentDictionary<(TelemetryActivityCategory, string), CommandCounters> _commands = new();
    private readonly ConcurrentDictionary<string, RouteCounters> _routes = new(StringComparer.Ordinal);
    private readonly CategoryCounters[] _categories;
    private readonly TimeProvider _timeProvider;
    private readonly Meter _meter;
    private readonly Counter<long> _commandCounter;
    private readonly Counter<long> _rowsReturnedCounter;
    private readonly Counter<long> _rowsAffectedCounter;
    private readonly Counter<long> _resultBytesCounter;
    private readonly Histogram<double> _durationHistogram;
    private readonly Counter<long> _connectionCounter;
    private readonly Counter<long> _retryCounter;
    private readonly Counter<long> _responseBytesCounter;
    private long _totalAttempts;
    private long _overflowedFingerprints;

    public TelemetryDatabaseMetrics(TimeProvider timeProvider)
    {
        _timeProvider = timeProvider;
        _categories = TelemetryActivityCategories.All.Select(_ => new CategoryCounters()).ToArray();
        _meter = new Meter(MeterName);
        _commandCounter = _meter.CreateCounter<long>("mor.telemetry.db.commands", description: "Database command executions by category, kind and outcome.");
        _rowsReturnedCounter = _meter.CreateCounter<long>("mor.telemetry.db.rows_returned", description: "Rows consumed from database results (reader: EF Read() calls, an upper bound).");
        _rowsAffectedCounter = _meter.CreateCounter<long>("mor.telemetry.db.rows_affected", description: "Rows inserted, updated or deleted.");
        _resultBytesCounter = _meter.CreateCounter<long>("mor.telemetry.db.estimated_result_bytes", unit: "By", description: "Estimated database result payload consumed by the backend. Not Neon network transfer.");
        _durationHistogram = _meter.CreateHistogram<double>("mor.telemetry.db.duration", unit: "ms", description: "Database command execution time.");
        _connectionCounter = _meter.CreateCounter<long>("mor.telemetry.db.connection_opens", description: "EF Core connection opens (pool checkouts, not necessarily physical connections).");
        _retryCounter = _meter.CreateCounter<long>("mor.telemetry.db.retries", description: "EF Core execution-strategy retries.");
        _responseBytesCounter = _meter.CreateCounter<long>("mor.telemetry.http.response_body_bytes", unit: "By", description: "Backend-to-browser response body bytes. Excludes headers and TLS.");
    }

    public TelemetryMeasurementCommand BeginCommand(TelemetryCommandKind kind, string? sql)
    {
        var shape = TelemetrySqlFingerprint.Describe(sql);
        var scope = TelemetryActivityScope.Current;
        var category = ResolveCategory(scope?.Category, shape);
        if (scope is null && sql is not null &&
            (sql.Contains("DELETE FROM \"TelemetryReadings\"", StringComparison.Ordinal) ||
             sql.Contains("DELETE FROM \"InaReadings\"", StringComparison.Ordinal) ||
             sql.Contains("DELETE FROM \"TelemetryReadingRollups\"", StringComparison.Ordinal)))
            category = TelemetryActivityCategory.RetentionBulk;

        var counters = GetCommandCounters(category, shape.Label);
        if (counters.IsOverflow) shape = shape with { Label = OverflowLabel };
        Interlocked.Increment(ref counters.Attempts);
        Interlocked.Increment(ref _categories[(int)category].Attempts);
        Interlocked.Increment(ref _totalAttempts);
        switch (kind)
        {
            case TelemetryCommandKind.Reader: Interlocked.Increment(ref counters.ReaderCommands); break;
            case TelemetryCommandKind.Scalar: Interlocked.Increment(ref counters.ScalarCommands); break;
            default: Interlocked.Increment(ref counters.NonQueryCommands); break;
        }

        scope?.AddCommand();
        return new TelemetryMeasurementCommand(kind, category, shape, counters, scope);
    }

    public static TelemetryActivityCategory ResolveCategory(TelemetryActivityCategory? scoped, TelemetrySqlShape shape)
    {
        if (scoped is { } background && TelemetryActivityCategories.IsBackground(background))
        {
            return background;
        }

        if (shape.TouchesIdentity)
        {
            return TelemetryActivityCategory.Authentication;
        }

        return scoped ?? TelemetryActivityCategory.Unattributed;
    }

    public void RecordCompleted(
        TelemetryMeasurementCommand command,
        TimeSpan executionDuration,
        long rowsReturned,
        long rowsAffected,
        long estimatedResultBytes,
        long readerReadCalls = 0,
        TimeSpan readerOpenDuration = default)
    {
        if (!command.TryComplete())
        {
            return;
        }

        var c = command.Counters;
        var category = _categories[(int)command.Category];
        Interlocked.Increment(ref c.Succeeded);
        Interlocked.Increment(ref category.Succeeded);
        AddCommon(command, c, category, executionDuration, rowsReturned, rowsAffected, estimatedResultBytes);
        Interlocked.Add(ref c.ReaderReadCalls, Math.Max(0, readerReadCalls));
        Interlocked.Add(ref c.ReaderOpenTicks, readerOpenDuration.Ticks);
        _commandCounter.Add(1, Tags(command, "succeeded"));
    }

    public void RecordFailed(TelemetryMeasurementCommand command, TimeSpan executionDuration, bool canceled, long rowsReturned = 0, long estimatedResultBytes = 0)
    {
        if (!command.TryComplete())
        {
            return;
        }

        var c = command.Counters;
        var category = _categories[(int)command.Category];
        if (canceled)
        {
            Interlocked.Increment(ref c.Canceled);
            Interlocked.Increment(ref category.Canceled);
        }
        else
        {
            Interlocked.Increment(ref c.Failed);
            Interlocked.Increment(ref category.Failed);
        }

        AddCommon(command, c, category, executionDuration, rowsReturned, 0, estimatedResultBytes);
        _commandCounter.Add(1, Tags(command, canceled ? "canceled" : "failed"));
    }

    public void RecordConnectionOpened(bool succeeded)
    {
        var category = TelemetryActivityScope.Current?.Category ?? TelemetryActivityCategory.Unattributed;
        if (succeeded)
        {
            Interlocked.Increment(ref _categories[(int)category].ConnectionOpens);
        }
        else
        {
            Interlocked.Increment(ref _categories[(int)category].ConnectionFailures);
        }

        _connectionCounter.Add(1,
            new KeyValuePair<string, object?>("category", TelemetryActivityCategories.Label(category)),
            new KeyValuePair<string, object?>("outcome", succeeded ? "succeeded" : "failed"));
    }

    public void RecordRetry()
    {
        var category = TelemetryActivityScope.Current?.Category ?? TelemetryActivityCategory.Unattributed;
        Interlocked.Increment(ref _categories[(int)category].Retries);
        _retryCounter.Add(1, new KeyValuePair<string, object?>("category", TelemetryActivityCategories.Label(category)));
    }

    public void RecordHttpResponse(string route, TelemetryActivityCategory category, int statusCode, long responseBodyBytes, long databaseCommands, long estimatedDatabaseResultBytes)
    {
        var key = _routes.ContainsKey(route) || _routes.Count < MaxRouteKeys ? route : OverflowLabel;
        var counters = _routes.GetOrAdd(key, _ => new RouteCounters(category));
        Interlocked.Increment(ref counters.Requests);
        if (statusCode >= 500)
        {
            Interlocked.Increment(ref counters.ServerErrors);
        }

        Interlocked.Add(ref counters.ResponseBodyBytes, responseBodyBytes);
        Interlocked.Add(ref counters.DatabaseCommands, databaseCommands);
        Interlocked.Add(ref counters.EstimatedDatabaseResultBytes, estimatedDatabaseResultBytes);
        _responseBytesCounter.Add(responseBodyBytes,
            new KeyValuePair<string, object?>("route", key),
            new KeyValuePair<string, object?>("category", TelemetryActivityCategories.Label(category)));
    }

    public TelemetryMeasurementReport Snapshot()
    {
        var commands = _commands
            .Select(pair => pair.Value.ToStats(pair.Key.Item1, pair.Key.Item2))
            .OrderBy(s => s.Category)
            .ThenByDescending(s => s.Attempts)
            .ThenBy(s => s.Fingerprint, StringComparer.Ordinal)
            .ToList();

        var categories = TelemetryActivityCategories.All
            .Select(category => _categories[(int)category].ToStats(category))
            .ToList();

        var routes = _routes
            .Select(pair => new TelemetryHttpRouteStats(
                pair.Key,
                pair.Value.Category,
                Interlocked.Read(ref pair.Value.Requests),
                Interlocked.Read(ref pair.Value.ServerErrors),
                Interlocked.Read(ref pair.Value.ResponseBodyBytes),
                Interlocked.Read(ref pair.Value.DatabaseCommands),
                Interlocked.Read(ref pair.Value.EstimatedDatabaseResultBytes)))
            .OrderBy(r => r.Route, StringComparer.Ordinal)
            .ToList();

        return new TelemetryMeasurementReport(
            _timeProvider.GetUtcNow(),
            Interlocked.Read(ref _totalAttempts),
            Interlocked.Read(ref _overflowedFingerprints),
            categories,
            commands,
            routes);
    }

    public void Dispose() => _meter.Dispose();

    private void AddCommon(
        TelemetryMeasurementCommand command,
        CommandCounters c,
        CategoryCounters category,
        TimeSpan executionDuration,
        long rowsReturned,
        long rowsAffected,
        long estimatedResultBytes)
    {
        rowsReturned = Math.Max(0, rowsReturned);
        rowsAffected = Math.Max(0, rowsAffected);
        estimatedResultBytes = Math.Max(0, estimatedResultBytes);

        Interlocked.Add(ref c.RowsReturned, rowsReturned);
        Interlocked.Add(ref c.RowsAffected, rowsAffected);
        Interlocked.Add(ref c.EstimatedResultBytes, estimatedResultBytes);
        Interlocked.Add(ref c.ExecutionTicks, executionDuration.Ticks);
        InterlockedMax(ref c.MaxExecutionTicks, executionDuration.Ticks);

        Interlocked.Add(ref category.RowsReturned, rowsReturned);
        Interlocked.Add(ref category.RowsAffected, rowsAffected);
        Interlocked.Add(ref category.EstimatedResultBytes, estimatedResultBytes);
        Interlocked.Add(ref category.ExecutionTicks, executionDuration.Ticks);

        command.Scope?.AddResultBytes(estimatedResultBytes);

        var categoryTag = new KeyValuePair<string, object?>("category", TelemetryActivityCategories.Label(command.Category));
        _rowsReturnedCounter.Add(rowsReturned, categoryTag);
        _rowsAffectedCounter.Add(rowsAffected, categoryTag);
        _resultBytesCounter.Add(estimatedResultBytes, categoryTag);
        _durationHistogram.Record(executionDuration.TotalMilliseconds, categoryTag,
            new KeyValuePair<string, object?>("kind", command.Kind.ToString()));
    }

    private static KeyValuePair<string, object?>[] Tags(TelemetryMeasurementCommand command, string outcome) =>
    [
        new("category", TelemetryActivityCategories.Label(command.Category)),
        new("kind", command.Kind.ToString()),
        new("outcome", outcome),
        new("fingerprint", command.Fingerprint),
    ];

    private CommandCounters GetCommandCounters(TelemetryActivityCategory category, string fingerprint)
    {
        var key = (category, fingerprint);
        if (_commands.TryGetValue(key, out var existing))
        {
            return existing;
        }

        // Adding a key is rare; the lock keeps the cap exact under concurrency.
        lock (_commands)
        {
            if (_commands.TryGetValue(key, out existing))
            {
                return existing;
            }

            if (_commands.Count >= MaxCommandKeys)
            {
                Interlocked.Increment(ref _overflowedFingerprints);
                return _commands.GetOrAdd((category, OverflowLabel), _ => new CommandCounters { IsOverflow = true });
            }

            return _commands.GetOrAdd(key, _ => new CommandCounters());
        }
    }

    private static void InterlockedMax(ref long target, long value)
    {
        var current = Interlocked.Read(ref target);
        while (value > current)
        {
            var observed = Interlocked.CompareExchange(ref target, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    internal sealed class CommandCounters
    {
        public bool IsOverflow;
        public long Attempts;
        public long Succeeded;
        public long Failed;
        public long Canceled;
        public long ReaderCommands;
        public long ScalarCommands;
        public long NonQueryCommands;
        public long RowsReturned;
        public long ReaderReadCalls;
        public long RowsAffected;
        public long EstimatedResultBytes;
        public long ExecutionTicks;
        public long MaxExecutionTicks;
        public long ReaderOpenTicks;

        public TelemetryCommandStats ToStats(TelemetryActivityCategory category, string fingerprint) => new(
            category,
            fingerprint,
            Interlocked.Read(ref Attempts),
            Interlocked.Read(ref Succeeded),
            Interlocked.Read(ref Failed),
            Interlocked.Read(ref Canceled),
            Interlocked.Read(ref ReaderCommands),
            Interlocked.Read(ref ScalarCommands),
            Interlocked.Read(ref NonQueryCommands),
            Interlocked.Read(ref RowsReturned),
            Interlocked.Read(ref ReaderReadCalls),
            Interlocked.Read(ref RowsAffected),
            Interlocked.Read(ref EstimatedResultBytes),
            TimeSpan.FromTicks(Interlocked.Read(ref ExecutionTicks)).TotalMilliseconds,
            TimeSpan.FromTicks(Interlocked.Read(ref MaxExecutionTicks)).TotalMilliseconds,
            TimeSpan.FromTicks(Interlocked.Read(ref ReaderOpenTicks)).TotalMilliseconds);
    }

    private sealed class CategoryCounters
    {
        public long Attempts;
        public long Succeeded;
        public long Failed;
        public long Canceled;
        public long Retries;
        public long RowsReturned;
        public long RowsAffected;
        public long EstimatedResultBytes;
        public long ConnectionOpens;
        public long ConnectionFailures;
        public long ExecutionTicks;

        public TelemetryCategoryStats ToStats(TelemetryActivityCategory category) => new(
            category,
            Interlocked.Read(ref Attempts),
            Interlocked.Read(ref Succeeded),
            Interlocked.Read(ref Failed),
            Interlocked.Read(ref Canceled),
            Interlocked.Read(ref Retries),
            Interlocked.Read(ref RowsReturned),
            Interlocked.Read(ref RowsAffected),
            Interlocked.Read(ref EstimatedResultBytes),
            Interlocked.Read(ref ConnectionOpens),
            Interlocked.Read(ref ConnectionFailures),
            TimeSpan.FromTicks(Interlocked.Read(ref ExecutionTicks)).TotalMilliseconds);
    }

    private sealed class RouteCounters(TelemetryActivityCategory category)
    {
        public readonly TelemetryActivityCategory Category = category;
        public long Requests;
        public long ServerErrors;
        public long ResponseBodyBytes;
        public long DatabaseCommands;
        public long EstimatedDatabaseResultBytes;
    }
}

/// <summary>
/// One in-flight command. Completion is recorded at most once, whichever of
/// the executed/failed/reader-closed paths reaches it first.
/// </summary>
public sealed class TelemetryMeasurementCommand
{
    private int _completed;

    internal TelemetryMeasurementCommand(
        TelemetryCommandKind kind,
        TelemetryActivityCategory category,
        TelemetrySqlShape shape,
        TelemetryDatabaseMetrics.CommandCounters counters,
        TelemetryActivityScope? scope)
    {
        Kind = kind;
        Category = category;
        Shape = shape;
        Counters = counters;
        Scope = scope;
    }

    public TelemetryCommandKind Kind { get; }

    public TelemetryActivityCategory Category { get; }

    public TelemetrySqlShape Shape { get; }

    public string Fingerprint => Shape.Label;

    public bool IsCompleted => Volatile.Read(ref _completed) != 0;

    internal TelemetryDatabaseMetrics.CommandCounters Counters { get; }

    internal TelemetryActivityScope? Scope { get; }

    // Set when a reader command executes successfully; EF's reader-disposing
    // callback supplies the read count and completes the command.
    internal TimeSpan ExecutionDuration { get; set; }

    // Estimated bytes per DataRow, from the result's column metadata.
    internal long EstimatedRowBytes { get; set; }

    internal bool TryComplete() => Interlocked.Exchange(ref _completed, 1) == 0;
}
