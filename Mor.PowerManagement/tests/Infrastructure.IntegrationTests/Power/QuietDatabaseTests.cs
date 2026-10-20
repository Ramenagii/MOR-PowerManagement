using System.Diagnostics;
using System.Net;
using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Queries.GetDashboardState;
using Mor.PowerManagement.Application.Power.Queries.GetDeviceConfig;
using Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Identity;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Mor.PowerManagement.Infrastructure.Observability;
using Mor.PowerManagement.Infrastructure.Power;
using Mor.PowerManagement.Infrastructure.Power.History;
using Npgsql;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>
/// PLAN-0001 Spec G against the local throwaway PostgreSQL only. A real
/// Kestrel host (loopback, ephemeral port) runs the Application and
/// Infrastructure registrations with <c>Telemetry:QuietDatabaseMode</c>, A's
/// interceptors count every command and connection open, and
/// <c>pg_stat_database.sessions</c> counts physical connections. Hosted
/// services run on <see cref="SteppedClock"/>, a timer-capable virtual clock,
/// so 15-minute windows elapse in seconds. Nothing here touches Neon.
///
/// Non-Development hosts use the <c>Staging</c> environment: <c>Production</c>
/// forces SslMode=Require, which the local container does not offer. The
/// Production connection-string path is covered by the unit tests (G-3).
/// </summary>
[NonParallelizable]
public class QuietDatabaseTests
{
    private const string NonDevelopment = "Staging";
    private const string SyntheticPassword = "Quiet-Synthetic-Only-1!";

    private PostgresFixture _database = null!;
    private readonly List<string> _evidence = new();

    [OneTimeSetUp]
    public async Task OpenDatabase() => _database = await PostgresFixture.CreateAsync();

    [OneTimeTearDown]
    public async Task CloseDatabase()
    {
        if (_database is not null) await _database.DisposeAsync();
    }

    [SetUp]
    public void ClearEvidence() => _evidence.Clear();

    [TearDown]
    public void PublishEvidence()
    {
        foreach (var line in _evidence) TestContext.Out.WriteLine(line);
    }

    // ------------------------------------------------------------------------
    // G-1 / G-2: health endpoints
    // ------------------------------------------------------------------------

    [Test]
    public async Task QuietDatabase_G1_ThousandLivenessCalls_ZeroDatabaseActivity()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var sessions = await PhysicalSessions.OpenAsync(_database);
        var before = host.Metrics.Snapshot();

        for (var i = 0; i < 1_000; i++)
        {
            using var response = await host.Http.GetAsync("/alive");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        }

        var after = host.Metrics.Snapshot();
        var physical = await sessions.DeltaAsync();
        _evidence.Add($"1,000 GET /alive ({NonDevelopment}, quiet ON): {after.TotalCommandAttempts - before.TotalCommandAttempts} commands, " +
                      $"{Opens(after) - Opens(before)} connection opens, {physical} physical sessions, " +
                      $"{after.For(TelemetryActivityCategory.HealthChecks).Attempts} health-check commands");
        Assert.That(after.TotalCommandAttempts - before.TotalCommandAttempts, Is.Zero);
        Assert.That(Opens(after) - Opens(before), Is.Zero);
        Assert.That(physical, Is.Zero);
    }

    [Test]
    public async Task QuietDatabase_PhysicalSessionCounter_DetectsANewConnection()
    {
        // Positive control for the zero readings elsewhere: one short unpooled
        // connection must show up in pg_stat_database.sessions.
        var sessions = await PhysicalSessions.OpenAsync(_database);
        await using (var probe = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(_database.ConnectionString) { Pooling = false }.ConnectionString))
        {
            await probe.OpenAsync();
            await using var command = new NpgsqlCommand("SELECT 1", probe);
            await command.ExecuteScalarAsync();
        }

        var physical = await sessions.DeltaAsync();
        _evidence.Add($"positive control: 1 unpooled connection -> {physical} physical session(s) counted");
        Assert.That(physical, Is.EqualTo(1));
    }

    [Test]
    public async Task QuietDatabase_G1_FlagOff_NonDevelopment_HealthEndpointsStayUnmapped()
    {
        await using var host = await QuietHost.StartAsync(_database, new() { Quiet = false });
        using var alive = await host.Http.GetAsync("/alive");
        using var health = await host.Http.GetAsync("/health");
        _evidence.Add($"quiet OFF, {NonDevelopment}: GET /alive -> {(int)alive.StatusCode}, GET /health -> {(int)health.StatusCode} " +
                      "(unmapped; the real app falls through to the SPA index.html)");
        Assert.That(alive.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        Assert.That(health.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }

    [Test]
    public async Task QuietDatabase_G1_FlagOff_Production_AliveStaysUnmapped_NoConnectionAttempt()
    {
        // Production forces SslMode=Require, which the local container lacks, so this
        // host points at a documentation-range address (RFC 5737) and does no startup
        // database work: the check is routing only.
        await using var host = await QuietHost.StartAsync(_database, new()
        {
            Quiet = false,
            Environment = Environments.Production,
            ConnectionString = "Host=192.0.2.1;Port=5432;Database=synthetic;Username=synthetic;Password=synthetic;Timeout=3",
        });
        using var alive = await host.Http.GetAsync("/alive");
        using var health = await host.Http.GetAsync("/health");
        var report = host.Metrics.Snapshot();
        _evidence.Add($"quiet OFF, Production: GET /alive -> {(int)alive.StatusCode}, GET /health -> {(int)health.StatusCode}; " +
                      $"{report.TotalCommandAttempts} commands, {Opens(report)} connection opens");
        Assert.That(alive.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        Assert.That(health.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        Assert.That(report.TotalCommandAttempts, Is.Zero);
    }

    [Test]
    public async Task QuietDatabase_G2_HundredReadinessCalls_ZeroDatabaseActivity_Healthy()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var sessions = await PhysicalSessions.OpenAsync(_database);
        var before = host.Metrics.Snapshot();

        for (var i = 0; i < 100; i++)
        {
            using var response = await host.Http.GetAsync("/health");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
            Assert.That(await response.Content.ReadAsStringAsync(), Is.EqualTo("Healthy"));
        }

        var after = host.Metrics.Snapshot();
        var physical = await sessions.DeltaAsync();
        _evidence.Add($"100 GET /health ({NonDevelopment}, quiet ON): {after.TotalCommandAttempts - before.TotalCommandAttempts} commands, " +
                      $"{Opens(after) - Opens(before)} connection opens, {physical} physical sessions");
        Assert.That(after.TotalCommandAttempts - before.TotalCommandAttempts, Is.Zero);
        Assert.That(Opens(after) - Opens(before), Is.Zero);
        Assert.That(physical, Is.Zero);
    }

    [Test]
    public async Task QuietDatabase_G2_FailedHydration_ReadinessIs503_LivenessStays200()
    {
        // Program.cs stops startup on a failed hydration. The test host keeps
        // going so readiness can be probed: it must report the real state.
        await using var host = await QuietHost.StartAsync(_database, new() { FailHydration = true });
        Assert.That(host.Store.Published, Is.Null);
        using var health = await host.Http.GetAsync("/health");
        using var alive = await host.Http.GetAsync("/alive");
        _evidence.Add($"failed hydration: GET /health -> {(int)health.StatusCode} {await health.Content.ReadAsStringAsync()}, GET /alive -> {(int)alive.StatusCode}");
        Assert.That(health.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
        Assert.That(alive.StatusCode, Is.EqualTo(HttpStatusCode.OK));
    }

    [Test]
    public async Task QuietDatabase_G2_UnrecordedHistoryGap_ReadinessIs503()
    {
        await using var host = await QuietHost.StartAsync(_database, new()
        {
            Extra = { ["Telemetry:History:MaxBufferedAcquisitions"] = "1", ["Telemetry:History:BridgeMaxAcquisitions"] = "0" },
        });
        await host.Ingest(host.Run.Sample());
        host.Clock.Advance(TimeSpan.FromSeconds(1));
        await host.Ingest(host.Run.Sample());
        var status = host.Buffer.GetStatus();
        using var health = await host.Http.GetAsync("/health");
        _evidence.Add($"buffer overflow: dropped {status.TotalDroppedAcquisitions}, gaps {status.Gaps.Count} (recorded {status.Gaps.Count(g => g.Recorded)}), " +
                      $"GET /health -> {(int)health.StatusCode} {await health.Content.ReadAsStringAsync()}");
        Assert.That(status.TotalDroppedAcquisitions, Is.EqualTo(1));
        Assert.That(health.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
    }

    [Test]
    public async Task QuietDatabase_G2_FlagOffDevelopment_DatabaseCheckRunsPerCall_Baseline()
    {
        await using var host = await QuietHost.StartAsync(_database, new() { Quiet = false, Environment = Environments.Development });
        var sessions = await PhysicalSessions.OpenAsync(_database);
        var before = host.Metrics.Snapshot();
        const int calls = 10;
        for (var i = 0; i < calls; i++)
        {
            using var response = await host.Http.GetAsync("/health");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        }

        var after = host.Metrics.Snapshot();
        var physical = await sessions.DeltaAsync();
        var checks = host.App.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<HealthCheckServiceOptions>>().Value.Registrations.Select(r => r.Name);
        _evidence.Add($"BASELINE quiet OFF, Development: {calls} GET /health -> {physical} physical sessions, " +
                      $"{after.TotalCommandAttempts - before.TotalCommandAttempts} EF commands, {Opens(after) - Opens(before)} EF connection opens; checks: {string.Join(", ", checks)}");
        Assert.That(checks, Does.Contain(nameof(ApplicationDbContext)));
        // The check reuses a pooled physical connection, but every call is a
        // database round trip; on Neon each one is activity that resets suspension.
        Assert.That(after.TotalCommandAttempts - before.TotalCommandAttempts, Is.GreaterThanOrEqualTo(calls), "the Aspire DbContext check queries once per call");
        Assert.That(Opens(after) - Opens(before), Is.GreaterThanOrEqualTo(calls));
    }

    // ------------------------------------------------------------------------
    // G-4 / G-5: startup, single maintenance path, empty interval
    // ------------------------------------------------------------------------

    [Test]
    public async Task QuietDatabase_G5_HostedServices_NoIndependentDatabaseTimer()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var hosted = host.App.Services.GetServices<IHostedService>().ToList();
        var names = hosted.Select(h => h.GetType().Name).ToList();
        var retention = hosted.OfType<TelemetryRetentionService>().Single();
        var coordinator = hosted.OfType<BatchWindowCoordinator>().Single();
        _evidence.Add($"hosted services (quiet ON): {string.Join(", ", names)}");
        _evidence.Add($"TelemetryRetentionService.ExecuteTask completed at start: {retention.ExecuteTask?.IsCompleted}; " +
                      $"BatchWindowCoordinator running: {coordinator.ExecuteTask is { IsCompleted: false }}; virtual timers: {host.Clock.ActiveTimers}");
        Assert.That(retention.ExecuteTask?.IsCompleted, Is.True, "legacy retention returns at once under batch persistence; maintenance runs only inside batch windows");
        Assert.That(coordinator.ExecuteTask is { IsCompleted: false }, Is.True);
        Assert.That(host.Clock.ActiveTimers, Is.EqualTo(1), "the coordinator's 1 s memory-only tick is the only timer on the host clock");
        // OpenTelemetry's TelemetryHostedService (Aspire Npgsql instrumentation) and
        // DataProtectionHostedService (Identity cookies; default key ring, not the
        // database) hold no database connection.
        Assert.That(names.Except([nameof(TelemetryRetentionService), nameof(BatchWindowCoordinator), "HealthCheckPublisherHostedService", "GenericWebHostService",
            "TelemetryHostedService", "DataProtectionHostedService"]), Is.Empty, "no other hosted service is registered");
        Assert.That(host.App.Services.GetServices<IHealthCheckPublisher>(), Is.Empty);
    }

    [Test]
    public async Task QuietDatabase_G4_StartupAttributed_ThenEmptyOffHoursInterval_ZeroQueries()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var startup = host.Metrics.Snapshot();
        _evidence.Add($"startup: {startup.TotalCommandAttempts} commands = startup {startup.For(TelemetryActivityCategory.Startup).Attempts} + " +
                      $"retention-bulk {startup.For(TelemetryActivityCategory.RetentionBulk).Attempts} (initialization maintenance) + " +
                      $"unattributed {startup.For(TelemetryActivityCategory.Unattributed).Attempts}; hydrations {host.Store.HydrationCount}");
        Assert.That(startup.For(TelemetryActivityCategory.Unattributed).Attempts, Is.Zero);
        Assert.That(startup.TotalCommandAttempts, Is.EqualTo(startup.For(TelemetryActivityCategory.Startup).Attempts + startup.For(TelemetryActivityCategory.RetentionBulk).Attempts));
        Assert.That(host.Store.HydrationCount, Is.EqualTo(1));

        var sessions = await PhysicalSessions.OpenAsync(_database);
        var interval = host.FlushInterval * 2;
        await host.AdvanceAsync(interval);
        await host.SettleAsync();
        var after = host.Metrics.Snapshot();
        var physical = await sessions.DeltaAsync();
        _evidence.Add($"empty off-hours interval {interval.TotalSeconds:0} virtual s (2 x flush interval): {after.TotalCommandAttempts - startup.TotalCommandAttempts} commands, " +
                      $"{Opens(after) - Opens(startup)} connection opens, {physical} physical sessions");
        Assert.That(after.TotalCommandAttempts - startup.TotalCommandAttempts, Is.Zero);
        Assert.That(Opens(after) - Opens(startup), Is.Zero);
        Assert.That(physical, Is.Zero);
    }

    // ------------------------------------------------------------------------
    // Timeline (accelerated clock): device, off-hours, pollers, history,
    // control durability and batch/maintenance contention
    // ------------------------------------------------------------------------

    [Test]
    public async Task QuietDatabase_Timeline_DeviceOnly_ThenOffHours()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var start = host.Metrics.Snapshot();

        // One full batch window of device traffic: telemetry 1 Hz, config 2 Hz.
        var windowSeconds = (int)host.FlushInterval.TotalSeconds;
        for (var s = 0; s < windowSeconds; s++)
        {
            await host.DeviceSecondAsync(100);
        }

        await host.SettleAsync();
        var device = host.Metrics.Snapshot();
        var flushes = host.Buffer.GetStatus();
        _evidence.Add($"device-only {windowSeconds} virtual s ({windowSeconds} ingests, {windowSeconds * 2} config polls): " +
                      $"config {Delta(start, device, TelemetryActivityCategory.DeviceConfiguration)}, ingest {Delta(start, device, TelemetryActivityCategory.TelemetryIngest)}, " +
                      $"retention-bulk {Delta(start, device, TelemetryActivityCategory.RetentionBulk)} commands; committed acquisitions {flushes.TotalCommittedAcquisitions}; " +
                      $"last flush {flushes.LastFlush?.Trigger} {flushes.LastFlush?.Outcome} {flushes.LastFlush?.Acquisitions} acq");
        Assert.That(Delta(start, device, TelemetryActivityCategory.DeviceConfiguration), Is.Zero);
        Assert.That(Delta(start, device, TelemetryActivityCategory.TelemetryIngest), Is.Zero, "steady load: no control transition, no per-sample write");
        Assert.That(Delta(start, device, TelemetryActivityCategory.RetentionBulk), Is.GreaterThan(0), "the scheduled batch flushed inside the window");
        Assert.That(device.TotalCommandAttempts - start.TotalCommandAttempts, Is.EqualTo(Delta(start, device, TelemetryActivityCategory.RetentionBulk)));

        // Device stops: one inactivity flush, then silence.
        await host.AdvanceAsync(TimeSpan.FromSeconds(60));
        await host.SettleAsync();
        var drained = host.Metrics.Snapshot();
        Assert.That(host.Buffer.GetStatus().BufferedRows, Is.Zero, "the inactivity flush drained the buffer");

        var sessions = await PhysicalSessions.OpenAsync(_database);
        await host.AdvanceAsync(host.FlushInterval * 2);
        await host.SettleAsync();
        var quiet = host.Metrics.Snapshot();
        var physical = await sessions.DeltaAsync();
        _evidence.Add($"device stopped: inactivity flush {drained.TotalCommandAttempts - device.TotalCommandAttempts} commands; " +
                      $"then {(host.FlushInterval * 2).TotalSeconds:0} virtual s: {quiet.TotalCommandAttempts - drained.TotalCommandAttempts} commands, {physical} physical sessions");
        Assert.That(quiet.TotalCommandAttempts - drained.TotalCommandAttempts, Is.Zero);
        Assert.That(physical, Is.Zero);
    }

    [TestCase(1)]
    [TestCase(3)]
    public async Task QuietDatabase_Timeline_AuthenticatedPollers_35Minutes(int sessions)
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var admins = await host.SeedAdministratorsAsync(sessions);
        var start = host.Metrics.Snapshot();

        // Login per session: lookup, password check, principal (claims/roles).
        var principals = new List<ClaimsPrincipal>();
        foreach (var admin in admins) principals.Add(await host.LoginAsync(admin));
        var afterLogin = host.Metrics.Snapshot();

        // 35 virtual minutes: device 1 Hz telemetry + 2 Hz config, each console
        // polls state every 2 s; Identity's SecurityStampValidator interval (30 min)
        // elapses once per session.
        var revalidations = 0;
        var revalidateAt = TimeSpan.FromMinutes(30);
        var elapsed = TimeSpan.Zero;
        while (elapsed < TimeSpan.FromMinutes(35))
        {
            await host.DeviceSecondAsync(100);
            elapsed += TimeSpan.FromSeconds(1);
            if ((int)elapsed.TotalSeconds % 2 == 0)
            {
                for (var i = 0; i < admins.Count; i++) await host.PollStateAsync(admins[i]);
            }

            if (elapsed == revalidateAt)
            {
                foreach (var principal in principals)
                {
                    Assert.That(await host.RevalidateAsync(principal), Is.True);
                    revalidations++;
                }
            }
        }

        await host.SettleAsync();
        var end = host.Metrics.Snapshot();
        var polls = (int)(TimeSpan.FromMinutes(35).TotalSeconds / 2) * sessions;
        var authLogin = Delta(start, afterLogin, TelemetryActivityCategory.Authentication);
        var authRevalidate = Delta(afterLogin, end, TelemetryActivityCategory.Authentication);
        _evidence.Add($"{sessions} authenticated session(s), 35 virtual min, {polls} state polls, 2100 ingests, 4200 config polls: " +
                      $"state {Delta(afterLogin, end, TelemetryActivityCategory.DashboardCurrentState)}, config {Delta(afterLogin, end, TelemetryActivityCategory.DeviceConfiguration)}, " +
                      $"ingest {Delta(afterLogin, end, TelemetryActivityCategory.TelemetryIngest)}, retention-bulk {Delta(afterLogin, end, TelemetryActivityCategory.RetentionBulk)}, " +
                      $"authentication: login {authLogin} ({authLogin / sessions} per session), revalidation {authRevalidate} ({revalidations} revalidations), unattributed {Delta(start, end, TelemetryActivityCategory.Unattributed)}");
        Assert.That(Delta(afterLogin, end, TelemetryActivityCategory.DashboardCurrentState), Is.Zero);
        Assert.That(Delta(afterLogin, end, TelemetryActivityCategory.DeviceConfiguration), Is.Zero);
        Assert.That(Delta(afterLogin, end, TelemetryActivityCategory.TelemetryIngest), Is.Zero);
        Assert.That(Delta(start, end, TelemetryActivityCategory.Unattributed), Is.Zero);
        Assert.That(authLogin, Is.GreaterThan(0));
        Assert.That(revalidations, Is.EqualTo(sessions));
        Assert.That(authRevalidate, Is.GreaterThan(0), "revalidation is real Identity work, attributed to Authentication and kept (no bypass)");
        Assert.That(end.Reconciles, Is.True);
    }

    [Test]
    public async Task QuietDatabase_Timeline_HistoryAttributedSeparately()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        var admin = (await host.SeedAdministratorsAsync(1)).Single();
        for (var s = 0; s < 120; s++) await host.DeviceSecondAsync(100);
        await host.SettleAsync();
        var start = host.Metrics.Snapshot();

        var rows = new List<string>();
        foreach (var window in new[] { TelemetryWindow.Minutes15, TelemetryWindow.Hour1, TelemetryWindow.Minutes15 })
        {
            var before = host.Metrics.Snapshot();
            await host.HistoryAsync(admin, window);
            var after = host.Metrics.Snapshot();
            rows.Add($"{GetTelemetrySeriesQuery.ToWireValue(window)}={after.TotalCommandAttempts - before.TotalCommandAttempts}");
        }

        var end = host.Metrics.Snapshot();
        _evidence.Add($"history requests (commands each: {string.Join(", ", rows)}): history {Delta(start, end, TelemetryActivityCategory.History)}, " +
                      $"authentication {Delta(start, end, TelemetryActivityCategory.Authentication)}, state {Delta(start, end, TelemetryActivityCategory.DashboardCurrentState)}, " +
                      $"unattributed {Delta(start, end, TelemetryActivityCategory.Unattributed)}");
        Assert.That(Delta(start, end, TelemetryActivityCategory.History), Is.GreaterThan(0), "a prefix miss reads the database and is attributed to History");
        Assert.That(end.TotalCommandAttempts - start.TotalCommandAttempts, Is.EqualTo(Delta(start, end, TelemetryActivityCategory.History)),
            "history work is never mixed into authentication, state or unattributed");
    }

    [Test]
    public async Task QuietDatabase_Timeline_ControlTransitionsAreDurableBeforeTheResponse()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        await host.DeviceSecondAsync(100);
        var before = host.Metrics.Snapshot();
        var eventsBefore = (await host.Run.EventsAsync()).Count;

        // Overload confirmed after 3 s: an immediate control transition.
        await host.DeviceSecondAsync(1400);
        await host.AdvanceAsync(TimeSpan.FromSeconds(2));
        var shed = await host.Ingest(host.Run.Sample(1400));
        var outlets = await host.Run.OutletsAsync();
        var events = await host.Run.EventsAsync();
        var afterShed = host.Metrics.Snapshot();
        _evidence.Add($"overload transition: state {shed.State}, events raised [{string.Join(", ", shed.EventsRaised)}], durable outlet-1 status {outlets[0].Status}, " +
                      $"events {eventsBefore} -> {events.Count}, ingest commands {Delta(before, afterShed, TelemetryActivityCategory.TelemetryIngest)} (immediate), buffered rows {host.Buffer.GetStatus().BufferedRows}");
        Assert.That(events.Count, Is.GreaterThan(eventsBefore), "the transition's event was committed before the ingest returned");
        Assert.That(outlets.Select(o => o.Status), Is.EqualTo(host.Store.Published!.Outlets.Select(o => o.Status)), "durable state equals the published snapshot");
        Assert.That(Delta(before, afterShed, TelemetryActivityCategory.TelemetryIngest), Is.GreaterThan(0));

        // Administrator commands commit before they return, every time.
        for (var i = 0; i < 10; i++)
        {
            var minutes = 10 + i;
            await host.ControlAsync(new UpdateThresholdsCommand { StandbyIdleMinutes = minutes });
            await using var db = _database.CreateMigrationContext();
            Assert.That((await db.PowerSystemConfigs.AsNoTracking().SingleAsync()).StandbyIdleMinutes, Is.EqualTo(minutes));
        }

        var end = host.Metrics.Snapshot();
        _evidence.Add($"10 administrator threshold commands: each durable on return; admin-control commands {Delta(afterShed, end, TelemetryActivityCategory.AdministratorControl)}");
    }

    [Test]
    public async Task QuietDatabase_Timeline_BatchAndMaintenance_MeasuredWithControlLatency()
    {
        await using var host = await QuietHost.StartAsync(_database, new());
        // Retention work for the maintenance window: synthetic rows older than raw retention.
        var seeded = await SeedExpiredTelemetryAsync(host.Clock.GetUtcNow().AddHours(-12), 120_000);

        // Control latency with no batch in progress (baseline).
        var idle = new List<double>();
        for (var i = 0; i < 20; i++) idle.Add(await host.TimedControlAsync(20 + (i % 2)));

        // Fill one batch (860 acquisitions, below the scheduled-flush age).
        for (var s = 0; s < 860; s++)
        {
            await host.Ingest(host.Run.Sample(100));
            host.Clock.Advance(TimeSpan.FromSeconds(1));
        }

        var buffered = host.Buffer.GetStatus();
        var flushClock = Stopwatch.StartNew();
        var flush = host.Coordinator.FlushAsync("contention-test");
        var contended = new List<double>();
        while (!flush.IsCompleted)
        {
            contended.Add(await host.TimedControlAsync(30 + (contended.Count % 2)));
        }

        Assert.That(await flush, Is.True);
        flushClock.Stop();
        var status = host.Buffer.GetStatus();
        await using (var db = _database.CreateMigrationContext())
        {
            var remaining = await db.TelemetryReadings.CountAsync(r => r.Timestamp < host.Clock.GetUtcNow().AddHours(-6));
            _evidence.Add($"LOCAL Docker PostgreSQL 18, not Neon: batch {buffered.ActiveAcquisitions} acquisitions / {buffered.BufferedRows} rows + maintenance over {seeded} expired rows " +
                          $"took {flushClock.Elapsed.TotalMilliseconds:0} ms wall; expired rows remaining {remaining}");
        }

        _evidence.Add($"control latency (UpdateThresholds, durable): idle p50 {Percentile(idle, 50):0.0} ms / max {idle.Max():0.0} ms; " +
                      $"during batch+maintenance n={contended.Count} p50 {Percentile(contended, 50):0.0} ms / max {(contended.Count == 0 ? 0 : contended.Max()):0.0} ms");
        Assert.That(status.TotalCommittedAcquisitions, Is.GreaterThanOrEqualTo(860));
        Assert.That(contended, Is.Not.Empty, "at least one control command ran while the batch window was open");
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private static long Opens(TelemetryMeasurementReport report) => report.Categories.Sum(c => c.ConnectionOpens);

    private static long Delta(TelemetryMeasurementReport before, TelemetryMeasurementReport after, TelemetryActivityCategory category)
        => after.For(category).Attempts - before.For(category).Attempts;

    private static double Percentile(List<double> values, int percentile)
    {
        if (values.Count == 0) return 0;
        var sorted = values.OrderBy(v => v).ToList();
        return sorted[Math.Clamp((int)Math.Ceiling(percentile / 100.0 * sorted.Count) - 1, 0, sorted.Count - 1)];
    }

    private async Task<long> SeedExpiredTelemetryAsync(DateTimeOffset at, int rows)
    {
        await using var connection = new NpgsqlConnection(_database.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            INSERT INTO "TelemetryReadings" ("OutletId", "Timestamp", "Voltage", "CurrentAmps", "PowerWatts", "EnergyKwh")
            SELECT 1 + (g % 5), @at - make_interval(secs => g), 238, 0.4, 100, 1
            FROM generate_series(1, @rows) AS g
            """, connection);
        command.Parameters.AddWithValue("at", at);
        command.Parameters.AddWithValue("rows", rows);
        return await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Physical connections established to the test database, from
    /// <c>pg_stat_database.sessions</c>, read over one dedicated unpooled
    /// connection that is itself counted before the baseline.
    /// </summary>
    private sealed class PhysicalSessions
    {
        private NpgsqlConnection _reader = null!;
        private long _baseline;

        public static async Task<PhysicalSessions> OpenAsync(PostgresFixture database)
        {
            var reader = new PhysicalSessions
            {
                _reader = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(database.ConnectionString) { Pooling = false }.ConnectionString),
            };
            await reader._reader.OpenAsync();
            await Task.Delay(TimeSpan.FromMilliseconds(1_500)); // let the reader's own connect statistic flush
            reader._baseline = await reader.ReadAsync();
            return reader;
        }

        public async Task<long> DeltaAsync()
        {
            await Task.Delay(TimeSpan.FromMilliseconds(1_500)); // backends flush statistics at exit or within ~1 s idle
            var delta = await ReadAsync() - _baseline;
            await _reader.DisposeAsync();
            return delta;
        }

        private async Task<long> ReadAsync()
        {
            await using (var clear = new NpgsqlCommand("SELECT pg_stat_clear_snapshot()", _reader)) await clear.ExecuteNonQueryAsync();
            await using var read = new NpgsqlCommand("SELECT sessions FROM pg_stat_database WHERE datname = current_database()", _reader);
            return (long)(await read.ExecuteScalarAsync())!;
        }
    }

    private sealed class QuietHostOptions
    {
        public bool Quiet { get; init; } = true;

        public string Environment { get; init; } = NonDevelopment;

        public bool FailHydration { get; init; }

        /// <summary>Overrides the fixture connection string (synthetic hosts only); skips startup database work.</summary>
        public string? ConnectionString { get; init; }

        public Dictionary<string, string?> Extra { get; } = new();
    }

    /// <summary>
    /// The production registrations on Kestrel, started the way Program.cs
    /// starts them, minus two steps: the seeder (the fixture already holds the
    /// schema and B's baseline forbids seeding here) and the single-writer
    /// file guard (no database traffic; covered by Spec D).
    /// </summary>
    private sealed class QuietHost : IAsyncDisposable
    {
        public required WebApplication App { get; init; }
        public required HttpClient Http { get; init; }
        public required SteppedClock Clock { get; init; }
        public required ControlScenarioRunner Run { get; init; }
        public TelemetryDatabaseMetrics Metrics => App.Services.GetRequiredService<TelemetryDatabaseMetrics>();
        public BoundedHistoryBuffer Buffer => App.Services.GetRequiredService<BoundedHistoryBuffer>();
        public BatchWindowCoordinator Coordinator => App.Services.GetRequiredService<BatchWindowCoordinator>();
        public IPowerRuntimeStore Store => App.Services.GetRequiredService<IPowerRuntimeStore>();
        public TimeSpan FlushInterval => App.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<HistoryPersistenceOptions>>().Value.FlushInterval;

        public static async Task<QuietHost> StartAsync(PostgresFixture database, QuietHostOptions options)
        {
            var run = new ControlScenarioRunner(database);
            await run.SeedAsync();
            var clock = new SteppedClock(ControlledTimeProvider.DefaultStart.AddMinutes(1));

            // An empty builder: no environment variables, user secrets or
            // appsettings can redirect the connection away from the fixture.
            var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions { EnvironmentName = options.Environment });
            builder.WebHost.UseKestrelCore().UseUrls("http://127.0.0.1:0");
            builder.Services.AddRouting();
            var values = new Dictionary<string, string?>
            {
                [$"ConnectionStrings:{Mor.PowerManagement.Shared.Services.Database}"] = options.ConnectionString ?? database.ConnectionString,
                [QuietDatabaseOptions.QuietDatabaseModeKey] = options.Quiet ? "true" : "false",
                [PowerRuntimeOptions.CachedReadsEnabledKey] = "true",
                [HistoryPersistenceOptions.RuntimeIngestEnabledKey] = "true",
                [HistoryPersistenceOptions.BatchPersistenceEnabledKey] = "true",
                ["Telemetry:Measurement:Enabled"] = "true",
            };
            foreach (var (key, value) in options.Extra) values[key] = value;
            builder.Configuration.AddInMemoryCollection(values);

            builder.Services.AddLogging();
            // ServiceDefaults' AddDefaultHealthChecks: the in-process liveness check.
            builder.Services.AddHealthChecks().AddCheck("self", () => HealthCheckResult.Healthy(), [QuietDatabaseRegistration.LiveTag]);
            var quiet = builder.AddQuietDatabase();
            builder.AddApplicationServices();
            builder.AddInfrastructureServices();
            builder.Services.AddSingleton<TimeProvider>(clock);
            builder.Services.AddSingleton(run.Framework);
            builder.Services.AddScoped<TestUser>();
            builder.Services.AddScoped<IUser>(sp => sp.GetRequiredService<TestUser>());
            builder.Services.AddScoped<ICurrentUserName>(sp => new ClaimsCurrentUserName(() => sp.GetRequiredService<TestUser>().Principal));
            if (options.FailHydration)
            {
                builder.Services.RemoveAll<IPowerRuntimeHydrator>();
                builder.Services.AddSingleton<IPowerRuntimeHydrator, FailingHydrator>();
            }

            var app = builder.Build();
            app.Use(async (context, next) =>
            {
                // Web's request-measurement middleware, by path only.
                using var scope = TelemetryActivityScope.Begin(TelemetryActivityCategories.FromRequestPath(context.Request.Path));
                await next(context);
            });

            using (TelemetryActivityScope.Begin(TelemetryActivityCategory.Startup))
            {
                app.EnsureQuietDatabasePolicy();

                // A synthetic, unroutable connection string means a routing-only host: no startup database work.
                if (options.ConnectionString is null)
                {
                    try
                    {
                        await app.HydratePowerRuntimeAsync();
                    }
                    catch (PowerRuntimeUnavailableException) when (options.FailHydration)
                    {
                    }

                    await app.InitializeHistoryPersistenceAsync();
                }
            }

            if (quiet.Enabled)
            {
                app.MapQuietDatabaseHealthEndpoints();
            }
            else if (app.Environment.IsDevelopment())
            {
                // ServiceDefaults.MapDefaultEndpoints, unchanged.
                app.MapHealthChecks("/health");
                app.MapHealthChecks("/alive", new HealthCheckOptions { Predicate = r => r.Tags.Contains(QuietDatabaseRegistration.LiveTag) });
            }

            await app.StartAsync();
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
            return new QuietHost { App = app, Http = new HttpClient { BaseAddress = new Uri(address) }, Clock = clock, Run = run };
        }

        /// <summary>Advances virtual time one second at a time so the coordinator observes every tick.</summary>
        public async Task AdvanceAsync(TimeSpan duration)
        {
            for (var t = TimeSpan.Zero; t < duration; t += TimeSpan.FromSeconds(1))
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                await Task.Yield();
            }
        }

        /// <summary>One device second: two config polls and one telemetry acquisition, then the clock moves.</summary>
        public async Task DeviceSecondAsync(double watts)
        {
            await DeviceConfigAsync();
            await Ingest(Run.Sample(watts));
            await DeviceConfigAsync();
            Clock.Advance(TimeSpan.FromSeconds(1));
            await Task.Yield();
        }

        public async Task<IngestTelemetryResult> Ingest(IngestTelemetryCommand command)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.TelemetryIngest);
            using var scope = App.Services.CreateScope();
            return await scope.ServiceProvider.GetRequiredService<ISender>().Send(command);
        }

        public async Task DeviceConfigAsync()
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.DeviceConfiguration);
            using var scope = App.Services.CreateScope();
            await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDeviceConfigQuery());
        }

        public async Task PollStateAsync(ApplicationUser admin)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.DashboardCurrentState);
            using var scope = App.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<TestUser>().SignIn(admin.Id, admin.UserName!);
            await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDashboardStateQuery());
        }

        public async Task HistoryAsync(ApplicationUser admin, TelemetryWindow window)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.History);
            using var scope = App.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<TestUser>().SignIn(admin.Id, admin.UserName!);
            await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetTelemetrySeriesQuery { Window = window, OutletIds = [1, 2, 3, 4, 5] });
        }

        public async Task<int> ControlAsync<T>(T command) where T : IRequest<int>
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.AdministratorControl);
            using var scope = App.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<TestUser>().SignIn("control-admin", "control@localhost");
            return await scope.ServiceProvider.GetRequiredService<ISender>().Send(command);
        }

        /// <summary>A durable administrator command, timed with a real stopwatch.</summary>
        public async Task<double> TimedControlAsync(int standbyIdleMinutes)
        {
            var watch = Stopwatch.StartNew();
            await ControlAsync(new UpdateThresholdsCommand { StandbyIdleMinutes = standbyIdleMinutes });
            return watch.Elapsed.TotalMilliseconds;
        }

        public async Task<List<ApplicationUser>> SeedAdministratorsAsync(int count)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.Startup);
            using var scope = App.Services.CreateScope();
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var created = new List<ApplicationUser>();
            for (var i = 1; i <= count; i++)
            {
                var user = new ApplicationUser { UserName = $"quiet{i}@localhost", Email = $"quiet{i}@localhost" };
                var result = await users.CreateAsync(user, SyntheticPassword);
                Assert.That(result.Succeeded, Is.True, string.Join("; ", result.Errors.Select(e => e.Code)));
                created.Add(user);
            }

            return created;
        }

        /// <summary>Identity's login work: user lookup, password check and principal creation (claims, roles, security stamp).</summary>
        public async Task<ClaimsPrincipal> LoginAsync(ApplicationUser admin)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.Authentication);
            using var scope = App.Services.CreateScope();
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var signIn = scope.ServiceProvider.GetRequiredService<SignInManager<ApplicationUser>>();
            var user = await users.FindByNameAsync(admin.UserName!);
            Assert.That((await signIn.CheckPasswordSignInAsync(user!, SyntheticPassword, lockoutOnFailure: true)).Succeeded, Is.True);
            return await signIn.CreateUserPrincipalAsync(user!);
        }

        /// <summary>The query SecurityStampValidator runs when its interval elapses for a cookie.</summary>
        public async Task<bool> RevalidateAsync(ClaimsPrincipal principal)
        {
            using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.Authentication);
            using var scope = App.Services.CreateScope();
            var signIn = scope.ServiceProvider.GetRequiredService<SignInManager<ApplicationUser>>();
            return await signIn.ValidateSecurityStampAsync(principal) is not null;
        }

        /// <summary>Waits until no batch is in flight and the command counters stop moving.</summary>
        public async Task SettleAsync()
        {
            var last = -1L;
            for (var i = 0; i < 200; i++)
            {
                await Task.Delay(50);
                var now = Metrics.Snapshot().TotalCommandAttempts;
                if (now == last && Buffer.GetStatus().InFlightAcquisitions == 0) return;
                last = now;
            }
        }

        public async ValueTask DisposeAsync()
        {
            Http.Dispose();
            await App.StopAsync();
            await App.DisposeAsync();
        }
    }

    private sealed class FailingHydrator : IPowerRuntimeHydrator
    {
        public Task<PowerRuntimeSnapshot> LoadAsync(CancellationToken cancellationToken)
            => throw new InvalidOperationException("Injected hydration failure (test).");
    }

    private sealed class TestUser : IUser
    {
        public string? Id { get; private set; }

        public List<string>? Roles { get; private set; }

        public ClaimsPrincipal? Principal { get; private set; }

        public void SignIn(string id, string userName)
        {
            Id = id;
            Roles = ["Administrator"];
            Principal = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, id), new Claim(ClaimTypes.Name, userName), new Claim(ClaimTypes.Role, "Administrator")],
                "Identity.Application"));
        }
    }
}

/// <summary>
/// A virtual clock that also runs timers, for hosted services (B's
/// <see cref="ControlledTimeProvider"/> deliberately does not). Time moves only
/// through <see cref="Advance"/>, which fires every timer due on the way, in
/// order. Timestamps (<see cref="TimeProvider.GetTimestamp"/>) stay real, so
/// measured durations are wall-clock. Always UTC.
/// </summary>
internal sealed class SteppedClock(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private readonly List<SteppedTimer> _timers = new();
    private DateTimeOffset _now = start.ToUniversalTime();

    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;

    public int ActiveTimers
    {
        get
        {
            lock (_gate) return _timers.Count(t => t.DueAt.HasValue);
        }
    }

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate) return _now;
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new SteppedTimer(this, callback, state);
        timer.Change(dueTime, period);
        return timer;
    }

    public void Advance(TimeSpan delta)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(delta, TimeSpan.Zero);
        DateTimeOffset target;
        lock (_gate) target = _now + delta;
        while (true)
        {
            SteppedTimer? next;
            lock (_gate)
            {
                next = _timers.Where(t => t.DueAt is { } due && due <= target).OrderBy(t => t.DueAt).FirstOrDefault();
                if (next is null)
                {
                    _now = target;
                    return;
                }

                _now = next.DueAt!.Value;
                next.DueAt = next.Period > TimeSpan.Zero && next.Period != Timeout.InfiniteTimeSpan ? _now + next.Period : null;
            }

            next.Fire();
        }
    }

    private sealed class SteppedTimer(SteppedClock clock, TimerCallback callback, object? state) : ITimer
    {
        public DateTimeOffset? DueAt { get; set; }

        public TimeSpan Period { get; private set; }

        public void Fire() => callback(state);

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (clock._gate)
            {
                if (!clock._timers.Contains(this)) clock._timers.Add(this);
                Period = period;
                DueAt = dueTime == Timeout.InfiniteTimeSpan ? null : clock._now + dueTime;
            }

            return true;
        }

        public void Dispose()
        {
            lock (clock._gate) clock._timers.Remove(this);
        }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
