using System.Collections.Concurrent;
using System.Data;
using System.Data.Common;
using System.Diagnostics.Metrics;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Infrastructure.Observability;
using Npgsql;
using NUnit.Framework;

namespace Mor.PowerManagement.Application.UnitTests.Power.Measurement;

public class TelemetryMeasurementTests
{
    private const string FixtureSecret = "fixture-secret-password-token";

    [TestCase(null)]
    [TestCase("false")]
    public void Disabled_RegistersNoInterceptorsOrDatabaseWork(string? setting)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Telemetry:Measurement:Enabled"] = setting }).Build();
        var services = new ServiceCollection();
        services.AddTelemetryMeasurement(config);
        using var provider = services.BuildServiceProvider();
        Assert.That(provider.GetService<TelemetryDatabaseInterceptor>(), Is.Null);
        Assert.That(provider.GetService<TelemetryConnectionInterceptor>(), Is.Null);
        Assert.That(provider.GetService<TelemetryDatabaseMetrics>(), Is.Null);
        Assert.That(services, Is.Empty);

        var options = new DbContextOptionsBuilder();
        options.AddTelemetryMeasurementInterceptors(provider);
        Assert.That(options.Options.Extensions, Is.Empty);
    }

    [Test]
    public void FingerprintsAndCounters_DoNotExposeFixtureSecrets_AndAreBounded()
    {
        using var metrics = new TelemetryDatabaseMetrics(TimeProvider.System);
        Parallel.For(0, 1200, i =>
        {
            var c = metrics.BeginCommand(TelemetryCommandKind.Scalar, $"SELECT '{FixtureSecret}', column_{i} FROM \"{FixtureSecret}_{i}\" WHERE x = @p0");
            metrics.RecordCompleted(c, TimeSpan.Zero, 1, 0, 12);
        });
        var report = metrics.Snapshot();
        Assert.That(report.Reconciles, Is.True);
        Assert.That(report.Commands.Count, Is.LessThanOrEqualTo(TelemetryDatabaseMetrics.MaxCommandKeys + TelemetryActivityCategories.All.Count));
        Assert.That(string.Join(" ", report.Commands.Select(c => c.Fingerprint)), Does.Not.Contain(FixtureSecret));
        Assert.That(report.TotalCommandAttempts, Is.EqualTo(1200));
        Assert.That(report.OverflowedFingerprints, Is.GreaterThan(0));
    }

    [Test]
    public void Categories_ReconcileAndKeepBrowserAndDatabaseBytesSeparate()
    {
        using var metrics = new TelemetryDatabaseMetrics(TimeProvider.System);
        foreach (var category in TelemetryActivityCategories.All)
        {
            using var scope = TelemetryActivityScope.Begin(category);
            var c = metrics.BeginCommand(TelemetryCommandKind.Reader, "SELECT 1");
            metrics.RecordCompleted(c, TimeSpan.FromMilliseconds(2), 1, 0, 18);
            metrics.RecordHttpResponse(TelemetryActivityCategories.Label(category), category, 200, 100, scope.DatabaseCommands, scope.EstimatedResultBytes);
        }
        var report = metrics.Snapshot();
        Assert.That(report.Reconciles, Is.True);
        Assert.That(report.Categories.All(c => c.Attempts == 1), Is.True);
        Assert.That(report.TotalEstimatedDatabaseResultBytes, Is.EqualTo(18 * TelemetryActivityCategories.All.Count));
        Assert.That(report.TotalHttpResponseBodyBytes, Is.EqualTo(100 * TelemetryActivityCategories.All.Count));
        Assert.That(report.HttpRoutes.All(r => r.DatabaseCommands == 1 && r.EstimatedDatabaseResultBytes == 18), Is.True);
    }

    [TestCase("/api/Device/config", TelemetryActivityCategory.DeviceConfiguration)]
    [TestCase("/api/device/telemetry", TelemetryActivityCategory.TelemetryIngest)]
    [TestCase("/api/Dashboard/scenarios/ingest", TelemetryActivityCategory.TelemetryIngest)]
    [TestCase("/api/Dashboard/state", TelemetryActivityCategory.DashboardCurrentState)]
    [TestCase("/api/Dashboard/telemetry", TelemetryActivityCategory.History)]
    [TestCase("/api/Dashboard/outlets/3/activation", TelemetryActivityCategory.AdministratorControl)]
    [TestCase("/api/Users/login", TelemetryActivityCategory.Authentication)]
    [TestCase("/health", TelemetryActivityCategory.HealthChecks)]
    [TestCase("/alive", TelemetryActivityCategory.HealthChecks)]
    [TestCase("/api/Dashboard/stateful", TelemetryActivityCategory.AdministratorControl)]
    [TestCase("/healthz", TelemetryActivityCategory.Unattributed)]
    [TestCase("/index.html", TelemetryActivityCategory.Unattributed)]
    [TestCase(null, TelemetryActivityCategory.Unattributed)]
    public void RequestPaths_MapToBoundedCategories(string? path, TelemetryActivityCategory expected)
        => Assert.That(TelemetryActivityCategories.FromRequestPath(path), Is.EqualTo(expected));

    [Test]
    public void RowEstimate_UsesMetadataOnly_AndDoesNotAdvanceReader()
    {
        var table = new DataTable();
        table.Columns.Add("Id", typeof(int));
        table.Columns.Add("Watts", typeof(double));
        table.Columns.Add("Name", typeof(string));
        table.Rows.Add(1, 2.5, FixtureSecret);
        using var reader = new DataTableReader(table);

        var perRow = TelemetryResultEstimate.RowBytes(reader);

        Assert.That(perRow, Is.EqualTo(TelemetryResultEstimate.RowHeaderBytes
            + 3 * TelemetryResultEstimate.FieldHeaderBytes + 4 + 8 + TelemetryResultEstimate.NominalTextBytes));
        // Still positioned before the first row: the estimate read nothing.
        Assert.That(reader.Read(), Is.True);
        Assert.That(reader.GetInt32(0), Is.EqualTo(1));
        Assert.That(reader.Read(), Is.False);
    }

    [TestCase(false)]
    [TestCase(true)]
    public void Failures_AreCountedExactlyOnce(bool canceled)
    {
        using var metrics = new TelemetryDatabaseMetrics(TimeProvider.System);
        foreach (var kind in Enum.GetValues<TelemetryCommandKind>())
        {
            var command = metrics.BeginCommand(kind, "SELECT @parameter");
            metrics.RecordFailed(command, TimeSpan.Zero, canceled);
            metrics.RecordFailed(command, TimeSpan.Zero, canceled);
            metrics.RecordCompleted(command, TimeSpan.Zero, 1, 1, 1);
        }
        var stats = metrics.Snapshot().For(TelemetryActivityCategory.Unattributed);
        Assert.That(stats.Attempts, Is.EqualTo(3));
        Assert.That(canceled ? stats.Canceled : stats.Failed, Is.EqualTo(3));
        Assert.That(stats.Succeeded, Is.Zero);
    }

    [Test]
    public void BackgroundAndIdentityAttribution_UseExplicitScopeOrSqlShape()
    {
        using var metrics = new TelemetryDatabaseMetrics(TimeProvider.System);
        using (TelemetryActivityScope.Begin(TelemetryActivityCategory.Startup))
            Assert.That(metrics.BeginCommand(TelemetryCommandKind.Reader, "SELECT * FROM \"AspNetUsers\"").Category, Is.EqualTo(TelemetryActivityCategory.Startup));
        using (TelemetryActivityScope.Begin(TelemetryActivityCategory.DashboardCurrentState))
            Assert.That(metrics.BeginCommand(TelemetryCommandKind.Reader, "SELECT * FROM \"AspNetUsers\"").Category, Is.EqualTo(TelemetryActivityCategory.Authentication));
        Assert.That(metrics.BeginCommand(TelemetryCommandKind.Reader, "SELECT * FROM \"AspNetUsers\"").Category, Is.EqualTo(TelemetryActivityCategory.Authentication));
        Assert.That(metrics.BeginCommand(TelemetryCommandKind.NonQuery, "DELETE FROM \"InaReadings\" WHERE 1=0").Category, Is.EqualTo(TelemetryActivityCategory.RetentionBulk));
        Assert.That(metrics.BeginCommand(TelemetryCommandKind.Reader, "SELECT 1").Category, Is.EqualTo(TelemetryActivityCategory.Unattributed));
    }

    // Explicitly opt-in, throwaway local database only. No migrations/seeder,
    // Neon or persistent tables: temporary tables die with the connection.
    [Test]
    public async Task LocalPostgres_ProviderReaderUnchanged_CountsAllCommandKindsAndOutcomes()
    {
        var raw = Environment.GetEnvironmentVariable("MOR_TEST_DB_CONNECTION");
        if (string.IsNullOrWhiteSpace(raw)) Assert.Ignore("Local PostgreSQL measurement evidence pending: MOR_TEST_DB_CONNECTION is absent.");
        var cs = new NpgsqlConnectionStringBuilder(raw!);
        Assert.That(cs.Host, Is.EqualTo("127.0.0.1"));
        Assert.That(cs.Port, Is.EqualTo(55432));
        Assert.That(cs.Database, Is.EqualTo("mor_test"));

        using var metrics = new TelemetryDatabaseMetrics(TimeProvider.System);
        using var emitted = new EmittedTagCollector();
        var probe = new ProviderProbe();
        // The probe runs after the measurement interceptor, so it sees exactly
        // the reader EF receives, and counts commands independently.
        var options = new DbContextOptionsBuilder<ProbeContext>().UseNpgsql(cs.ConnectionString)
            .AddInterceptors(new TelemetryDatabaseInterceptor(metrics), new TelemetryConnectionInterceptor(metrics), probe).Options;
        await using var context = new ProbeContext(options);
        await context.Database.OpenConnectionAsync();
        await context.Database.ExecuteSqlRawAsync("CREATE TEMP TABLE measurement_probe (\"Id\" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \"Value\" integer NOT NULL, \"Note\" text NULL)");

        // SaveChanges: provider-generated INSERT ... RETURNING "Id". Single row,
        // then a three-row batch.
        context.Add(new Probe { Value = 7, Note = FixtureSecret });
        Assert.That(await context.SaveChangesAsync(), Is.EqualTo(1));
        context.AddRange(new Probe { Value = 1 }, new Probe { Value = 2 }, new Probe { Value = 3 });
        Assert.That(await context.SaveChangesAsync(), Is.EqualTo(3));
        Assert.That(context.ChangeTracker.Entries<Probe>().All(e => e.Entity.Id > 0), Is.True);
        Assert.That(probe.ReaderTypes, Is.Not.Empty);
        Assert.That(probe.ReaderTypes.All(t => t == typeof(NpgsqlDataReader)), Is.True, "EF must receive the provider's own reader.");

        // UPDATE ... (SaveChanges without RETURNING) and a non-query UPDATE.
        var first = await context.Set<Probe>().SingleAsync(p => p.Value == 7);
        first.Value = 8;
        Assert.That(await context.SaveChangesAsync(), Is.EqualTo(1));
        Assert.That(context.Database.ExecuteSqlRaw("UPDATE measurement_probe SET \"Value\" = \"Value\" + 10 WHERE \"Value\" < 5"), Is.EqualTo(3));

        // Full enumeration of four rows.
        context.ChangeTracker.Clear();
        var rows = await context.Set<Probe>().AsNoTracking().OrderBy(p => p.Id).ToListAsync();
        Assert.That(rows.Select(r => r.Value), Is.EqualTo(new[] { 8, 11, 12, 13 }));

        // Early reader disposal: stop after one row; the connection stays usable.
        await foreach (var _ in context.Set<Probe>().AsNoTracking().OrderBy(p => p.Id).AsAsyncEnumerable())
            break;

        // Real scalar execution through EF's relational command pipeline.
        var parameters = new RelationalCommandParameterObject(
            context.GetService<IRelationalConnection>(), null, null, context,
            context.GetService<IRelationalCommandDiagnosticsLogger>(), CommandSource.Unknown);
        var rawSql = context.GetService<IRawSqlCommandBuilder>();
        Assert.That(await rawSql.Build("SELECT count(*) FROM measurement_probe").ExecuteScalarAsync(parameters), Is.EqualTo(4L));
        Assert.ThrowsAsync<PostgresException>(async () => await rawSql.Build("SELECT 1/0").ExecuteScalarAsync(parameters));

        // Reader and non-query failures.
        Assert.ThrowsAsync<PostgresException>(async () => await context.Database.SqlQueryRaw<int>("SELECT 1/0 AS \"Value\"").ToListAsync());
        Assert.Throws<PostgresException>(() => context.Database.ExecuteSqlRaw("UPDATE measurement_probe SET \"Value\" = 1/0"));

        // Cancellation during execution; the connection must remain usable.
        using (var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(250)))
        {
            Assert.That(async () => await context.Database.SqlQueryRaw<int>("SELECT 1 AS \"Value\" FROM pg_sleep(5)").ToListAsync(cts.Token),
                Throws.InstanceOf<OperationCanceledException>());
        }
        Assert.That(await context.Set<Probe>().CountAsync(), Is.EqualTo(4));

        var report = metrics.Snapshot();
        var stats = report.Commands;
        TestContext.Out.WriteLine(TelemetryMeasurementReport.TransferDisclaimer);
        foreach (var c in stats)
            TestContext.Out.WriteLine($"{c.Category} | {c.Fingerprint} | attempts={c.Attempts} ok={c.Succeeded} failed={c.Failed} canceled={c.Canceled} " +
                $"reader={c.ReaderCommands} scalar={c.ScalarCommands} nonquery={c.NonQueryCommands} rows={c.RowsReturned} reads={c.ReaderReadCalls} " +
                $"affected={c.RowsAffected} estBytes={c.EstimatedResultBytes}");

        // Every command EF executed is counted once and has a final outcome.
        Assert.That(report.Reconciles, Is.True);
        Assert.That(report.TotalCommandAttempts, Is.EqualTo(probe.Executing));
        Assert.That(stats.All(c => c.InFlight == 0), Is.True, "every reader was closed and disposed");
        // One failing scalar, reader and non-query each.
        Assert.That(stats.Sum(c => c.Failed), Is.EqualTo(3));
        Assert.That(stats.Where(c => c.Failed > 0).Select(c => (c.ReaderCommands, c.ScalarCommands, c.NonQueryCommands)),
            Is.EquivalentTo(new[] { (1L, 0L, 0L), (0L, 1L, 0L), (0L, 0L, 1L) }));
        Assert.That(stats.Sum(c => c.Canceled), Is.EqualTo(1));
        Assert.That(stats.Sum(c => c.ScalarCommands), Is.EqualTo(2));
        Assert.That(report.Categories.Sum(c => c.ConnectionOpens), Is.EqualTo(1));

        // RETURNING rows are counted and affected rows come from the provider.
        var inserts = stats.Where(c => c.Fingerprint.StartsWith("INSERT", StringComparison.Ordinal)).ToList();
        Assert.That(inserts.Sum(c => c.Succeeded), Is.EqualTo(2));
        Assert.That(inserts.Sum(c => c.RowsAffected), Is.EqualTo(4));
        Assert.That(inserts.Sum(c => c.RowsReturned), Is.InRange(4, 6), "four RETURNING rows, plus at most one terminating read per batch");
        Assert.That(inserts.Sum(c => c.EstimatedResultBytes), Is.GreaterThan(0));
        var updates = stats.Where(c => c.Fingerprint.StartsWith("UPDATE", StringComparison.Ordinal)).ToList();
        Assert.That(updates.Sum(c => c.RowsAffected), Is.EqualTo(4));

        // Selects: one single row lookup, a full four-row read and a one-row
        // early disposal; read counts are an upper bound by one per full result.
        var selects = stats.Where(c => c.Fingerprint.StartsWith("SELECT", StringComparison.Ordinal) && c.ReaderCommands > 0 && c.Failed == 0 && c.Canceled == 0).ToList();
        Assert.That(selects.Sum(c => c.RowsReturned), Is.InRange(1 + 4 + 1, 2 + 5 + 1 + 2));

        // Nothing sanitized leaks a fixture secret or parameter value.
        var exported = string.Join("\n", stats.Select(c => c.Fingerprint).Concat(emitted.Values));
        Assert.That(exported, Does.Not.Contain(FixtureSecret));
        Assert.That(exported, Does.Not.Contain(cs.Password ?? "mor_test_local"));
        Assert.That(exported, Does.Not.Contain("Password").IgnoreCase);
    }

    private sealed class ProbeContext(DbContextOptions<ProbeContext> options) : DbContext(options)
    {
        protected override void OnModelCreating(ModelBuilder b)
        {
            b.Entity<Probe>().ToTable("measurement_probe");
            b.Entity<Probe>().HasKey(p => p.Id);
            b.Entity<Probe>().Property(p => p.Id).UseIdentityAlwaysColumn();
        }
    }

    private sealed class Probe
    {
        public int Id { get; set; }
        public int Value { get; set; }
        public string? Note { get; set; }
    }

    private sealed class ProviderProbe : DbCommandInterceptor
    {
        private int _executing;
        public int Executing => Volatile.Read(ref _executing);
        public ConcurrentBag<Type> ReaderTypes { get; } = [];

        public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r) { Interlocked.Increment(ref _executing); return r; }
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r, CancellationToken t = default) => new(ReaderExecuting(c, e, r));
        public override InterceptionResult<object> ScalarExecuting(DbCommand c, CommandEventData e, InterceptionResult<object> r) { Interlocked.Increment(ref _executing); return r; }
        public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<object> r, CancellationToken t = default) => new(ScalarExecuting(c, e, r));
        public override InterceptionResult<int> NonQueryExecuting(DbCommand c, CommandEventData e, InterceptionResult<int> r) { Interlocked.Increment(ref _executing); return r; }
        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<int> r, CancellationToken t = default) => new(NonQueryExecuting(c, e, r));
        public override DbDataReader ReaderExecuted(DbCommand c, CommandExecutedEventData e, DbDataReader r) { ReaderTypes.Add(r.GetType()); return r; }
        public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand c, CommandExecutedEventData e, DbDataReader r, CancellationToken t = default) => new(ReaderExecuted(c, e, r));
    }

    // Captures every tag value the measurement meter emits.
    private sealed class EmittedTagCollector : IDisposable
    {
        private readonly MeterListener _listener = new();
        public ConcurrentBag<string> Values { get; } = [];

        public EmittedTagCollector()
        {
            _listener.InstrumentPublished = (instrument, listener) =>
            {
                if (instrument.Meter.Name == TelemetryDatabaseMetrics.MeterName) listener.EnableMeasurementEvents(instrument);
            };
            _listener.SetMeasurementEventCallback<long>((_, _, tags, _) => Collect(tags));
            _listener.SetMeasurementEventCallback<double>((_, _, tags, _) => Collect(tags));
            _listener.Start();
        }

        private void Collect(ReadOnlySpan<KeyValuePair<string, object?>> tags)
        {
            foreach (var tag in tags) Values.Add($"{tag.Key}={tag.Value}");
        }

        public void Dispose() => _listener.Dispose();
    }
}
