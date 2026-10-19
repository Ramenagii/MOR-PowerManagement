using System.Data.Common;
using System.Security.Claims;
using System.Text.Json;
using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Commands.AcknowledgeOutletFault;
using Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;
using Mor.PowerManagement.Application.Power.Commands.ClearOutletRecoveryState;
using Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;
using Mor.PowerManagement.Application.Power.Commands.RunStagedRestoration;
using Mor.PowerManagement.Application.Power.Commands.SetManualOverride;
using Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;
using Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;
using Mor.PowerManagement.Application.Power.Queries.GetDashboardState;
using Mor.PowerManagement.Application.Power.Queries.GetDeviceConfig;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Identity;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Mor.PowerManagement.Infrastructure.Observability;
using Mor.PowerManagement.Infrastructure.Power;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>
/// PLAN-0001 Spec D against PostgreSQL: zero-query cached reads (A's
/// interceptor is the counter), post-commit publication, failed commits,
/// concurrency, freshness, the mains-voltage window, and differential
/// equivalence of B's control traces with cached reads off and on.
/// </summary>
[NonParallelizable]
public class RuntimeReadTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

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
    // Zero-query reads through the full MediatR pipeline
    // ------------------------------------------------------------------------

    [Test]
    public async Task RuntimeRead_TenThousandConfigPolls_AfterHydration_ExecuteZeroQueries()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        using var app = BuildApp(cachedReads: true, run.Clock);
        var metrics = app.Services.GetRequiredService<TelemetryDatabaseMetrics>();

        await app.HydratePowerRuntimeAsync();
        var afterHydration = metrics.Snapshot();
        _evidence.Add($"hydration: {afterHydration.TotalCommandAttempts} commands, {Opens(afterHydration)} connection opens");

        DeviceConfigVm? last = null;
        for (var i = 0; i < 10_000; i++)
        {
            using var scope = app.Services.CreateScope();
            last = await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDeviceConfigQuery());
        }

        var after = metrics.Snapshot();
        var commands = after.TotalCommandAttempts - afterHydration.TotalCommandAttempts;
        var opens = Opens(after) - Opens(afterHydration);
        _evidence.Add($"10,000 GET config (MediatR, cached reads ON): {commands} database commands, {opens} connection opens");
        Assert.That(commands, Is.Zero);
        Assert.That(opens, Is.Zero);

        // Same answer the legacy two-query read gives.
        await using var db = _database.CreateMigrationContext();
        var legacy = await new GetDeviceConfigQueryHandler(db).Handle(new GetDeviceConfigQuery(), None);
        Assert.That(JsonSerializer.Serialize(last, Json), Is.EqualTo(JsonSerializer.Serialize(legacy, Json)));

        // Contrast: cached reads OFF, every poll reads configuration and roster.
        using var legacyApp = BuildApp(cachedReads: false, run.Clock);
        var legacyMetrics = legacyApp.Services.GetRequiredService<TelemetryDatabaseMetrics>();
        for (var i = 0; i < 100; i++)
        {
            using var scope = legacyApp.Services.CreateScope();
            await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDeviceConfigQuery());
        }

        _evidence.Add($"100 GET config (cached reads OFF, baseline): {legacyMetrics.Snapshot().TotalCommandAttempts} database commands");
        Assert.That(legacyMetrics.Snapshot().TotalCommandAttempts, Is.EqualTo(200));
    }

    [TestCase(1)]
    [TestCase(3)]
    public async Task RuntimeRead_ConcurrentAdministratorStatePollers_ExecuteZeroRecurringQueries_IncludingAspNetUsers(int pollers)
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var admins = await SeedUsersAsync(pollers);
        using var app = BuildApp(cachedReads: true, run.Clock);
        var metrics = app.Services.GetRequiredService<TelemetryDatabaseMetrics>();
        await app.HydratePowerRuntimeAsync();
        var baseline = metrics.Snapshot();

        const int pollsEach = 1_000;
        await Task.WhenAll(admins.Select(admin => Task.Run(async () =>
        {
            for (var i = 0; i < pollsEach; i++)
            {
                using var scope = app.Services.CreateScope();
                scope.ServiceProvider.GetRequiredService<TestUser>().SignIn(admin.Id, admin.UserName!);
                await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDashboardStateQuery());
            }
        })));

        var after = metrics.Snapshot();
        var commands = after.TotalCommandAttempts - baseline.TotalCommandAttempts;
        var identity = after.For(TelemetryActivityCategory.Authentication).Attempts - baseline.For(TelemetryActivityCategory.Authentication).Attempts;
        _evidence.Add($"{pollers} authenticated poller(s) x {pollsEach} GET state (cached reads ON): {commands} database commands, {identity} Authentication (AspNetUsers) commands, {Opens(after) - Opens(baseline)} connection opens");
        Assert.That(commands, Is.Zero);
        Assert.That(identity, Is.Zero);

        // Contrast: cached reads OFF. Every authenticated dispatch pays one
        // AspNetUsers lookup (W-12) plus five state queries.
        using var legacyApp = BuildApp(cachedReads: false, run.Clock);
        var legacyMetrics = legacyApp.Services.GetRequiredService<TelemetryDatabaseMetrics>();
        for (var i = 0; i < 20; i++)
        {
            using var scope = legacyApp.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<TestUser>().SignIn(admins[0].Id, admins[0].UserName!);
            await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetDashboardStateQuery());
        }

        var legacyReport = legacyMetrics.Snapshot();
        _evidence.Add($"20 authenticated GET state (cached reads OFF, baseline): {legacyReport.TotalCommandAttempts} commands, {legacyReport.For(TelemetryActivityCategory.Authentication).Attempts} Authentication (AspNetUsers)");
        Assert.That(legacyReport.For(TelemetryActivityCategory.Authentication).Attempts, Is.EqualTo(20));
        Assert.That(legacyReport.TotalCommandAttempts, Is.EqualTo(20 * 6));
    }

    [Test]
    public async Task RuntimeRead_ConcurrentFirstUseRequests_ExecuteOneHydration()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        using var app = BuildApp(cachedReads: true, run.Clock);
        var metrics = app.Services.GetRequiredService<TelemetryDatabaseMetrics>();
        var store = app.Services.GetRequiredService<IPowerRuntimeStore>();

        // No startup hydration: 40 concurrent first requests race to use the runtime.
        await Task.WhenAll(Enumerable.Range(0, 40).Select(i => Task.Run(async () =>
        {
            using var scope = app.Services.CreateScope();
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            if (i % 2 == 0) await sender.Send(new GetDeviceConfigQuery());
            else await sender.Send(new GetDashboardStateQuery());
        })));

        _evidence.Add($"40 concurrent first-use requests: {store.HydrationCount} hydration(s), {metrics.Snapshot().TotalCommandAttempts} database commands");
        Assert.That(store.HydrationCount, Is.EqualTo(1));
        Assert.That(metrics.Snapshot().TotalCommandAttempts, Is.EqualTo(5), "one hydration = five read-only queries");
    }

    [Test]
    public async Task RuntimeRead_SecondSameHostWriter_CannotAcquireTheGuard()
    {
        var run = new ControlScenarioRunner(_database);
        var lockDirectory = Path.Combine(Path.GetTempPath(), "mor-power-runtime-tests", Guid.NewGuid().ToString("N"));
        using var first = BuildApp(cachedReads: true, run.Clock, lockDirectory);
        using var second = BuildApp(cachedReads: true, run.Clock, lockDirectory);

        first.AcquirePowerRuntimeWriterGuard();
        var refused = Assert.Throws<SingleWriterGuardException>(() => second.AcquirePowerRuntimeWriterGuard());
        _evidence.Add($"second backend on the same database identity: {refused!.GetType().Name}");

        // Cached reads off: no guard is taken at all (legacy topology unchanged).
        using var legacy = BuildApp(cachedReads: false, run.Clock, lockDirectory);
        Assert.DoesNotThrow(() => legacy.AcquirePowerRuntimeWriterGuard());
    }

    // ------------------------------------------------------------------------
    // Post-commit publication
    // ------------------------------------------------------------------------

    [Test]
    public async Task RuntimeRead_FailedCommits_PublishNoConfigEventCommandOrFramework()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var rig = await Rig.CachedAsync(_database, run);
        // Arm a confirmed overload so the next acquisition sheds (command + event + framework).
        await rig.Ingest(run.Sample(1400));
        run.Clock.AdvanceSeconds(3);

        var before = rig.Store.Published!;
        var frameworkBefore = run.Framework.Current;
        var eventsBefore = (await run.EventsAsync()).Count;

        Assert.CatchAsync(() => WithFailingCommit(db =>
            new IngestTelemetryCommandHandler(db, run.Framework, run.Clock, rig.Mutations).Handle(run.Sample(1400), None)));
        Assert.CatchAsync(() => WithFailingCommit(db =>
            new ApplySelectiveResponseCommandHandler(db, run.Framework, run.Clock, rig.Mutations).Handle(new() { ManualOverride = true }, None)));
        Assert.CatchAsync(() => WithFailingCommit(db =>
            new SetManualOverrideCommandHandler(db, run.Framework, run.Clock, rig.Mutations).Handle(new() { Enabled = true }, None)));
        Assert.CatchAsync(() => WithFailingCommit(db =>
            new UpdateThresholdsCommandHandler(db, run.Clock, rig.Mutations).Handle(new() { CriticalThresholdWatts = 900, WarningThresholdWatts = 800 }, None)));
        Assert.CatchAsync(() => WithFailingCommit(db =>
            new DisconnectOutletCommandHandler(db, run.Clock, rig.Mutations).Handle(new() { OutletId = 2 }, None)));

        Assert.That(rig.Store.Published, Is.SameAs(before), "no failed commit published a snapshot");
        Assert.That(run.Framework.Current, Is.SameAs(frameworkBefore), "no failed commit published framework state");
        Assert.That(run.Framework.Current.ManualOverride, Is.False);
        Assert.That(run.Framework.Current.ShedLedger, Is.Empty);
        Assert.That(rig.Store.Published!.EffectiveConfig.CriticalThresholdWatts, Is.EqualTo(1300));
        Assert.That(rig.Store.Published.Outlets.All(o => o.PendingCommandId is null), Is.True);
        Assert.That((await run.EventsAsync()).Count, Is.EqualTo(eventsBefore), "the database rolled back too");
        await AssertSnapshotMatchesDatabaseAsync(rig);

        // The same acquisition then commits and publishes normally.
        var shed = await rig.Ingest(run.Sample(1400) with { AcquisitionSequence = 2 });
        Assert.That(shed.Shedding!.Action, Is.EqualTo("Shed"));
        Assert.That(rig.Store.Published!.Framework.ShedLedger.Select(r => r.OutletId), Is.EqualTo(new[] { 1 }));
        await AssertSnapshotMatchesDatabaseAsync(rig);

        // Contrast, legacy path: the documented pre-commit publication defect.
        var legacyFramework = new Mor.PowerManagement.Application.Power.Services.LoadSheddingStateStore();
        Assert.CatchAsync(() => WithFailingCommit(db =>
            new SetManualOverrideCommandHandler(db, legacyFramework, run.Clock).Handle(new() { Enabled = true }, None)));
        _evidence.Add($"legacy SetManualOverride with failed commit leaves ManualOverride={legacyFramework.Current.ManualOverride} (pre-commit defect); cached path leaves it {run.Framework.Current.ManualOverride}");
        Assert.That(legacyFramework.Current.ManualOverride, Is.True);
    }

    [Test]
    public async Task RuntimeRead_ConcurrentIngestAndAdminUpdates_PreserveOrderingAndFields()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var rig = await Rig.CachedAsync(_database, run);
        rig.Traced = false;

        var ingest = Task.Run(async () =>
        {
            for (var i = 0; i < 60; i++)
            {
                run.Clock.AdvanceSeconds(0.25);
                await rig.Ingest(run.Sample(100 + i));
            }
        });
        var policy = Task.Run(async () =>
        {
            for (var i = 1; i <= 4; i++)
            {
                await rig.Policy(new() { OutletId = i, Name = $"Bench {i}", AllowanceWatts = 250 + i });
            }
        });
        var thresholds = Task.Run(async () =>
        {
            foreach (var critical in new[] { 1290.0, 1280.0, 1270.0 })
            {
                await rig.Thresholds(new() { CriticalThresholdWatts = critical, WarningThresholdWatts = critical - 300 });
            }
        });
        var overrides = Task.Run(async () =>
        {
            foreach (var enabled in new[] { true, false, true, false })
            {
                await rig.Override(new() { Enabled = enabled });
            }
        });
        await Task.WhenAll(ingest, policy, thresholds, overrides);

        var published = rig.Store.Published!;
        Assert.That(published.LiveVersion, Is.EqualTo(1 + 60 + 4 + 3 + 4), "every commit published exactly once");
        Assert.That(published.EffectiveConfig.LastAcquisitionSequence, Is.EqualTo(60), "every in-order acquisition was accepted");
        Assert.That(published.EffectiveConfig.CriticalThresholdWatts, Is.EqualTo(1270));
        Assert.That(published.Outlets.Take(4).Select(o => o.Name), Is.EqualTo(new[] { "Bench 1", "Bench 2", "Bench 3", "Bench 4" }), "ingest publications did not overwrite admin fields");
        Assert.That(published.Outlets[0].CurrentWatts, Is.EqualTo(159), "admin publications did not overwrite live values");
        Assert.That(published.Framework.ManualOverride, Is.False);
        Assert.That(run.Framework.Current, Is.SameAs(published.Framework));
        await AssertSnapshotMatchesDatabaseAsync(rig);
    }

    [Test]
    public async Task RuntimeRead_RelayReportWithoutMatchingCommand_IsNotAnAcknowledgement()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var rig = await Rig.CachedAsync(_database, run);
        await rig.Off(1);
        var pending = rig.Store.Published!.Outlets[0].PendingCommandId!.Value;

        var wrong = Guid.NewGuid();
        await rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = wrong }] });
        var outlet = rig.Store.Published!.Outlets[0];
        Assert.That(outlet.LastRelayReport!.CommandId, Is.EqualTo(wrong));
        Assert.That(outlet.PendingCommandId, Is.EqualTo(pending));
        Assert.That(outlet.PendingCommandAcknowledgedAtUtc, Is.Null);

        // Matching id, wrong relay state: still not an acknowledgement.
        await rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = pending }] });
        Assert.That(rig.Store.Published!.Outlets[0].PendingCommandAcknowledgedAtUtc, Is.Null);

        await rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = pending }] });
        Assert.That(rig.Store.Published!.Outlets[0].PendingCommandAcknowledgedAtUtc, Is.EqualTo(run.Clock.Peek()));
        await AssertSnapshotMatchesDatabaseAsync(rig);
    }

    // ------------------------------------------------------------------------
    // Freshness and the mains-voltage window
    // ------------------------------------------------------------------------

    [Test]
    public async Task RuntimeRead_FreshnessExpires_WithoutDatabaseRefresh()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var rig = await Rig.CachedAsync(_database, run);
        await rig.Ingest(run.Sample(200) with { Ina = new() { BusV = 24.1, CurrentA = 0.01, PowerW = 0.241, ShuntMv = 1 } });

        using var metrics = new TelemetryDatabaseMetrics(run.Clock);
        await using var measured = MeasuredContext(metrics);
        var handler = new GetDashboardStateQueryHandler(measured, run.Framework, run.Clock, rig.Store);

        var fresh = await handler.Handle(new GetDashboardStateQuery(), None);
        run.Clock.AdvanceSeconds(30);
        var boundary = await handler.Handle(new GetDashboardStateQuery(), None);
        run.Clock.Advance(TimeSpan.FromMilliseconds(1));
        var expired = await handler.Handle(new GetDashboardStateQuery(), None);

        Assert.That(metrics.Snapshot().TotalCommandAttempts, Is.Zero, "freshness is judged against the clock, not by re-reading");
        Assert.That(fresh.DeviceOnline && boundary.DeviceOnline, Is.True);
        Assert.That(fresh.MainsVolts, Is.Not.Null);
        Assert.That(boundary.Ina226, Is.Not.Null, "exactly 30 s old is still fresh");
        Assert.That(expired.DeviceOnline, Is.False);
        Assert.That(expired.MainsVolts, Is.Null);
        Assert.That(expired.Ina226, Is.Null);
        _evidence.Add($"freshness: online {fresh.DeviceOnline}->{boundary.DeviceOnline}->{expired.DeviceOnline}, mainsVolts {fresh.MainsVolts}->{expired.MainsVolts?.ToString() ?? "null"}, 0 database commands");

        // The legacy queries agree at the same instant.
        await AssertSnapshotMatchesDatabaseAsync(rig);
    }

    [Test]
    public async Task RuntimeRead_MainsVoltageAverage_MatchesLegacySql_AcrossSamplesAndExpiryBoundaries()
    {
        var run = new ControlScenarioRunner(_database);
        await run.SeedAsync();
        var rig = await Rig.CachedAsync(_database, run);
        var random = new Random(19);
        var compared = 0;

        for (var second = 0; second < 75; second++)
        {
            var sample = run.Sample(150);
            var command = sample with
            {
                Readings = sample.Readings.Select(r => r with
                {
                    Voltage = second % 11 == 0 && r.OutletId == 3 ? 0 : Math.Round(215 + random.NextDouble() * 25, 3),
                }).ToList(),
                Ina = second % 4 == 0 ? new() { BusV = 24 + random.NextDouble(), CurrentA = 0.01 } : null,
            };
            await rig.Ingest(command);

            foreach (var offset in new[] { 0, 1, 500, 29_999, 30_000, 30_001 })
            {
                var probe = run.Clock.Peek().AddMilliseconds(offset);
                var cached = GetDashboardStateQueryHandler.Project(rig.Store.Published!, probe);
                var probeClock = new ControlledTimeProvider(probe);
                await using var db = _database.CreateMigrationContext();
                var legacy = await new GetDashboardStateQueryHandler(db, run.Framework, probeClock, null).Handle(new GetDashboardStateQuery(), None);

                if (legacy.MainsVolts is null)
                {
                    Assert.That(cached.MainsVolts, Is.Null, $"t={second}s +{offset}ms");
                }
                else
                {
                    Assert.That(cached.MainsVolts, Is.EqualTo(legacy.MainsVolts.Value).Within(1e-9), $"t={second}s +{offset}ms");
                }

                Assert.That(JsonSerializer.Serialize(cached.Ina226, Json), Is.EqualTo(JsonSerializer.Serialize(legacy.Ina226, Json)), $"INA t={second}s +{offset}ms");
                compared++;
            }

            run.Clock.AdvanceSeconds(1);
        }

        _evidence.Add($"mains-voltage average: {compared} probes (75 batches x 6 offsets incl. the 30 s boundary) match the legacy SQL AVG within 1e-9; window holds {rig.Store.Published!.VoltageWindow.Samples.Length} samples");
    }

    // ------------------------------------------------------------------------
    // B's control traces with cached reads off and on
    // ------------------------------------------------------------------------

    [Test]
    public async Task RuntimeRead_ControlTraces_AreEquivalent_WithCachedReadsOffAndOn()
    {
        var legacyRun = new ControlScenarioRunner(_database);
        await legacyRun.SeedAsync();
        await RunControlScriptAsync(Rig.Legacy(_database, legacyRun));
        var legacyTraces = legacyRun.Traces.ToList();

        var cachedRun = new ControlScenarioRunner(_database);
        await cachedRun.SeedAsync();
        var cachedRig = await Rig.CachedAsync(_database, cachedRun);
        await RunControlScriptAsync(cachedRig);
        var cachedTraces = cachedRun.Traces.ToList();

        var directory = Path.Combine(TestContext.CurrentContext.WorkDirectory, "control-traces");
        Directory.CreateDirectory(directory);
        await File.WriteAllLinesAsync(Path.Combine(directory, "RuntimeRead_Differential_CachedOff.jsonl"), legacyTraces);
        await File.WriteAllLinesAsync(Path.Combine(directory, "RuntimeRead_Differential_CachedOn.jsonl"), cachedTraces);

        _evidence.Add($"differential: {legacyTraces.Count} actions, cached-off vs cached-on traces byte-identical: {legacyTraces.SequenceEqual(cachedTraces)}; snapshot checked against the database after every cached action");
        Assert.That(cachedTraces, Has.Count.EqualTo(legacyTraces.Count));
        for (var i = 0; i < legacyTraces.Count; i++)
        {
            Assert.That(cachedTraces[i], Is.EqualTo(legacyTraces[i]), $"action {i + 1} diverged");
        }
    }

    /// <summary>
    /// One script exercising every Power mutation: confirmed overload and shed,
    /// wrong and matching acknowledgements, post-settle clearing, automatic
    /// recovery trial and its reversal, review hold, manual off/on, override,
    /// selective response, forced restoration, holds and clearances, policy and
    /// threshold changes, fault isolation, and warning-event de-duplication.
    /// In cached mode the snapshot is compared with the database after each step.
    /// </summary>
    private async Task RunControlScriptAsync(Rig rig)
    {
        var run = rig.Run;

        async Task Step(Func<Task> action)
        {
            await action();
            if (rig.Cached) await AssertSnapshotMatchesDatabaseAsync(rig);
        }

        // Confirmed overload, shed, wrong ack, matching ack, post-settle clear.
        await Step(() => rig.Ingest(run.Sample(1400)));
        run.Clock.AdvanceSeconds(3);
        await Step(() => rig.Ingest(run.Sample(1400)));
        var shedCommand = (await run.OutletsAsync())[0].PendingCommandId;
        await Step(() => rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = Guid.Parse("44444444-4444-4444-4444-444444444444") }] }));
        await Step(() => rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = shedCommand }] }));
        run.Clock.Advance(TimeSpan.FromMilliseconds(501));
        await Step(() => rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = shedCommand }] }));

        // Duplicate acquisition is ignored.
        await Step(() => rig.Ingest(run.Sample() with { AcquisitionSequence = 1 }));

        // Automatic recovery trial after the 55 s wait, then three fresh over-limit samples reverse it.
        run.Clock.AdvanceSeconds(56);
        await Step(() => rig.Ingest(run.Sample()));
        var trialCommand = (await run.OutletsAsync())[0].PendingCommandId;
        await Step(() => rig.Ingest(run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = trialCommand }] }));
        run.Clock.Advance(TimeSpan.FromMilliseconds(501));
        for (var i = 0; i < 3; i++)
        {
            await Step(() => rig.Ingest(run.Sample(1400) with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = trialCommand }] }));
            run.Clock.AdvanceSeconds(1);
        }

        // The reversal command is never acknowledged: review hold after 5 s.
        run.Clock.AdvanceSeconds(6);
        await Step(() => rig.Ingest(run.Sample()));
        await Step(() => rig.Ingest(run.Sample()));
        await Step(() => rig.ClearRecovery(1));

        // Manual off (debounced repeat), manual on, warning de-dup with an intervening event.
        await Step(() => rig.Off(2));
        await Step(() => rig.Off(2));
        await Step(() => rig.On(2));
        run.Clock.AdvanceSeconds(1);
        await Step(() => rig.Ingest(Load(run, 3, 1100)));
        await Step(() => rig.Override(new() { Enabled = true, Reason = "bench test" }));
        await Step(() => rig.Ingest(Load(run, 3, 1100)));
        await Step(() => rig.Ingest(Load(run, 3, 1100)));

        // Selective response while overridden, forced restoration, override off.
        await Step(() => rig.Selective(new() { Count = 3, ManualOverride = true }));
        run.Clock.AdvanceSeconds(1);
        await Step(() => rig.Restore(new() { Force = true }));
        await Step(() => rig.Override(new() { Enabled = false }));

        // Policy and thresholds.
        await Step(() => rig.Policy(new() { OutletId = 3, Name = "Scope bench", Priority = OutletPriority.Critical, AllowanceWatts = 450, IsProtected = true, IdleLimitMinutes = 15 }));
        await Step(() => rig.Thresholds(new() { WarningThresholdWatts = 1000, CriticalThresholdWatts = 1250, StandbyIdleMinutes = 20 }));

        // Fault isolation, then fault-hold acknowledgement and a blocked restore.
        run.Clock.AdvanceSeconds(1);
        await Step(() => rig.Ingest(run.Sample() with { FaultFlag = true }));
        await Step(() => rig.AckFault(4));
        await Step(() => rig.On(1));
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    /// <summary>
    /// The published snapshot must equal what the legacy database queries
    /// return at the same instant: dashboard state (including events, the
    /// mains-voltage average and the INA226 sample), device configuration, and
    /// a fresh hydration from the database.
    /// </summary>
    private async Task AssertSnapshotMatchesDatabaseAsync(Rig rig)
    {
        var now = rig.Run.Clock.Peek();
        var published = rig.Store.Published!;
        var probeClock = new ControlledTimeProvider(now);

        await using (var db = _database.CreateMigrationContext())
        {
            var legacy = await new GetDashboardStateQueryHandler(db, rig.Run.Framework, probeClock, null).Handle(new GetDashboardStateQuery(), None);
            var cached = GetDashboardStateQueryHandler.Project(published, now);
            AssertEventsEquivalent(cached.RecentEvents, legacy.RecentEvents);
            Assert.That(cached.MainsVolts.HasValue, Is.EqualTo(legacy.MainsVolts.HasValue));
            if (legacy.MainsVolts is { } volts) Assert.That(cached.MainsVolts!.Value, Is.EqualTo(volts).Within(1e-9));
            Assert.That(
                JsonSerializer.Serialize(cached with { RecentEvents = [], MainsVolts = null }, Json),
                Is.EqualTo(JsonSerializer.Serialize(legacy with { RecentEvents = [], MainsVolts = null }, Json)),
                "dashboard state from the snapshot equals the legacy queries");
        }

        await using (var db = _database.CreateMigrationContext())
        {
            var legacy = await new GetDeviceConfigQueryHandler(db).Handle(new GetDeviceConfigQuery(), None);
            Assert.That(JsonSerializer.Serialize(GetDeviceConfigQueryHandler.Project(published), Json), Is.EqualTo(JsonSerializer.Serialize(legacy, Json)),
                "device configuration from the snapshot equals the legacy queries");
        }

        await using (var db = _database.CreateMigrationContext())
        {
            // Post-commit publication without a reload equals a reload.
            var reloaded = await PowerRuntimeHydrator.LoadAsync(db, now, None);
            Assert.That(JsonSerializer.Serialize(published.Config, Json), Is.EqualTo(JsonSerializer.Serialize(reloaded.Config, Json)));
            Assert.That(
                JsonSerializer.Serialize(published.Outlets.Select(o => o with { LastRelayReport = null }), Json),
                Is.EqualTo(JsonSerializer.Serialize(reloaded.Outlets, Json)));
            Assert.That(JsonSerializer.Serialize(published.RecentEvents, Json), Is.EqualTo(JsonSerializer.Serialize(reloaded.RecentEvents, Json)));
            Assert.That(JsonSerializer.Serialize(published.LatestIna, Json), Is.EqualTo(JsonSerializer.Serialize(reloaded.LatestIna, Json)));
            Assert.That(published.Framework, Is.SameAs(rig.Run.Framework.Current));
        }
    }

    /// <summary>
    /// The legacy query orders by timestamp only, so events sharing a
    /// timestamp come back in an unspecified order (and may straddle the
    /// 20-row cut). Everything else must match exactly.
    /// </summary>
    private static void AssertEventsEquivalent(IReadOnlyList<PowerEventDto> cached, IReadOnlyList<PowerEventDto> legacy)
    {
        Assert.That(cached, Has.Count.EqualTo(legacy.Count));
        var cut = legacy.Count == PowerRuntimeSnapshot.RecentEventCapacity ? legacy.Min(e => e.Timestamp) : DateTimeOffset.MinValue;
        static List<PowerEventDto> Canon(IEnumerable<PowerEventDto> events) => events.OrderByDescending(e => e.Timestamp).ThenByDescending(e => e.Id).ToList();
        Assert.That(Canon(cached.Where(e => e.Timestamp > cut)), Is.EqualTo(Canon(legacy.Where(e => e.Timestamp > cut))));
        Assert.That(cached.Count(e => e.Timestamp == cut), Is.EqualTo(legacy.Count(e => e.Timestamp == cut)));
        Assert.That(cached.Select(e => e.Timestamp), Is.Ordered.Descending);
    }

    /// <summary>One acquisition with all load on <paramref name="outletId"/>.</summary>
    private static IngestTelemetryCommand Load(ControlScenarioRunner run, int outletId, double watts)
    {
        var sample = run.Sample();
        return sample with
        {
            Readings = sample.Readings
                .Select(r => r.OutletId == outletId
                    ? r with { PowerWatts = watts, CurrentAmps = watts / 238 }
                    : r with { PowerWatts = 0, CurrentAmps = 0 })
                .ToList(),
        };
    }

    private static long Opens(TelemetryMeasurementReport report) => report.Categories.Sum(c => c.ConnectionOpens);

    private async Task<T> WithFailingCommit<T>(Func<ApplicationDbContext, Task<T>> action)
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseNpgsql(_database.ConnectionString, npgsql => npgsql.MigrationsHistoryTable("__EFMigrationsHistory", _database.SchemaName))
            .ConfigureWarnings(warnings => warnings.Ignore(RelationalEventId.PendingModelChangesWarning))
            .AddInterceptors(new FailPowerEventInsert())
            .Options;
        await using var db = new ApplicationDbContext(options);
        return await action(db);
    }

    private ApplicationDbContext MeasuredContext(TelemetryDatabaseMetrics metrics)
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseNpgsql(_database.ConnectionString, npgsql => npgsql.MigrationsHistoryTable("__EFMigrationsHistory", _database.SchemaName))
            .ConfigureWarnings(warnings => warnings.Ignore(RelationalEventId.PendingModelChangesWarning))
            .AddInterceptors(new TelemetryDatabaseInterceptor(metrics), new TelemetryConnectionInterceptor(metrics))
            .Options;
        return new ApplicationDbContext(options);
    }

    private async Task<List<ApplicationUser>> SeedUsersAsync(int count)
    {
        await using var db = _database.CreateMigrationContext();
        var users = Enumerable.Range(1, count).Select(i => new ApplicationUser
        {
            Id = $"admin-{i}-{Guid.NewGuid():N}",
            UserName = $"admin{i}@localhost",
            NormalizedUserName = $"ADMIN{i}@LOCALHOST",
            Email = $"admin{i}@localhost",
            NormalizedEmail = $"ADMIN{i}@LOCALHOST",
            SecurityStamp = Guid.NewGuid().ToString("N"),
        }).ToList();
        db.Users.AddRange(users);
        await db.SaveChangesAsync();
        return users;
    }

    /// <summary>
    /// The real Application + Infrastructure registrations (MediatR pipeline,
    /// Identity, A's measurement) on the isolated schema. The host is built but
    /// never started, so no hosted service runs. Defaults are disabled so no
    /// environment variable or user secret can redirect the connection.
    /// </summary>
    private IHost BuildApp(bool cachedReads, TimeProvider clock, string? lockDirectory = null)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            DisableDefaults = true,
            EnvironmentName = Environments.Development,
        });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{Mor.PowerManagement.Shared.Services.Database}"] = _database.ConnectionString,
            [PowerRuntimeOptions.CachedReadsEnabledKey] = cachedReads ? "true" : "false",
            [PowerRuntimeOptions.SingleWriterLockDirectoryKey] = lockDirectory,
            ["Telemetry:Measurement:Enabled"] = "true",
        });
        builder.Services.AddLogging();
        builder.AddApplicationServices();
        builder.AddInfrastructureServices();
        builder.Services.AddSingleton(clock);
        builder.Services.AddScoped<TestUser>();
        builder.Services.AddScoped<IUser>(sp => sp.GetRequiredService<TestUser>());
        builder.Services.AddScoped<ICurrentUserName>(sp => new ClaimsCurrentUserName(() => sp.GetRequiredService<TestUser>().Principal));
        return builder.Build();
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

    /// <summary>Fails the transaction at the PowerEvents insert, after other statements ran.</summary>
    private sealed class FailPowerEventInsert : DbCommandInterceptor
    {
        private static void Check(DbCommand command)
        {
            if (command.CommandText.Contains("INSERT INTO \"PowerEvents\"", StringComparison.Ordinal)
                || command.CommandText.Contains("UPDATE \"PowerSystemConfigs\"", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Injected commit failure (test).");
            }
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r, CancellationToken t = default)
        {
            Check(c);
            return ValueTask.FromResult(r);
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<int> r, CancellationToken t = default)
        {
            Check(c);
            return ValueTask.FromResult(r);
        }
    }

    /// <summary>Runs Power handlers through B's scenario runner, legacy (B's constructors) or cached.</summary>
    private sealed class Rig
    {
        private readonly PostgresFixture _database;

        private Rig(PostgresFixture database, ControlScenarioRunner run, PowerRuntimeStore store, bool cached)
        {
            _database = database;
            Run = run;
            Store = store;
            Cached = cached;
            Mutations = new PowerMutationCoordinator(run.Framework, store, run.Clock);
        }

        public ControlScenarioRunner Run { get; }

        public PowerRuntimeStore Store { get; }

        public PowerMutationCoordinator Mutations { get; }

        public bool Cached { get; }

        /// <summary>
        /// True: every action goes through B's runner and appends a replay
        /// trace. The runner is sequential, so concurrent tests turn it off.
        /// </summary>
        public bool Traced { get; set; } = true;

        private async Task<T> Act<T>(string label, Func<ApplicationDbContext, Task<T>> action, object? input = null)
        {
            if (Traced) return await Run.ActAsync(label, action, input);
            await using var db = _database.CreateMigrationContext();
            return await action(db);
        }

        public static Rig Legacy(PostgresFixture database, ControlScenarioRunner run)
            => new(database, run, new PowerRuntimeStore(false, run.Framework, null), cached: false);

        public static async Task<Rig> CachedAsync(PostgresFixture database, ControlScenarioRunner run)
        {
            var store = new PowerRuntimeStore(true, run.Framework, new PowerRuntimeHydrator(() => database.CreateMigrationContext(), run.Clock));
            await store.GetAsync();
            return new Rig(database, run, store, cached: true);
        }

        public Task<IngestTelemetryResult> Ingest(IngestTelemetryCommand command) => Act("ingest", db => Cached
            ? new IngestTelemetryCommandHandler(db, Run.Framework, Run.Clock, Mutations).Handle(command, None)
            : new IngestTelemetryCommandHandler(db, Run.Framework, Run.Clock).Handle(command, None), command);

        public Task<OutletActivationResult> On(int id) => Act("manual-on", db => Cached
            ? new RequestOutletActivationCommandHandler(db, Run.Clock, Mutations).Handle(new() { OutletId = id }, None)
            : new RequestOutletActivationCommandHandler(db, Run.Clock).Handle(new() { OutletId = id }, None));

        public Task<int> Off(int id) => Act("manual-off", db => Cached
            ? new DisconnectOutletCommandHandler(db, Run.Clock, Mutations).Handle(new() { OutletId = id }, None)
            : new DisconnectOutletCommandHandler(db, Run.Clock).Handle(new() { OutletId = id }, None));

        public Task<int> AckFault(int id) => Act("ack-fault", db => Cached
            ? new AcknowledgeOutletFaultCommandHandler(db, Run.Clock, Mutations).Handle(new(id), None)
            : new AcknowledgeOutletFaultCommandHandler(db, Run.Clock).Handle(new(id), None));

        public Task<int> ClearRecovery(int id) => Act("clear-recovery", db => Cached
            ? new ClearOutletRecoveryStateCommandHandler(db, Run.Clock, Mutations).Handle(new(id), None)
            : new ClearOutletRecoveryStateCommandHandler(db, Run.Clock).Handle(new(id), None));

        public Task<SelectiveResponseResult> Selective(ApplySelectiveResponseCommand command) => Act("selective", db => Cached
            ? new ApplySelectiveResponseCommandHandler(db, Run.Framework, Run.Clock, Mutations).Handle(command, None)
            : new ApplySelectiveResponseCommandHandler(db, Run.Framework, Run.Clock).Handle(command, None), command);

        public Task<StagedRestorationResult> Restore(RunStagedRestorationCommand command) => Act("restore", db => Cached
            ? new RunStagedRestorationCommandHandler(db, Run.Framework, Run.Clock, Mutations).Handle(command, None)
            : new RunStagedRestorationCommandHandler(db, Run.Framework, Run.Clock).Handle(command, None), command);

        public Task<ManualOverrideResult> Override(SetManualOverrideCommand command) => Act("override", db => Cached
            ? new SetManualOverrideCommandHandler(db, Run.Framework, Run.Clock, Mutations).Handle(command, None)
            : new SetManualOverrideCommandHandler(db, Run.Framework, Run.Clock).Handle(command, None), command);

        public Task<int> Policy(UpdateOutletPolicyCommand command) => Act("policy", db => Cached
            ? new UpdateOutletPolicyCommandHandler(db, Run.Clock, Mutations).Handle(command, None)
            : new UpdateOutletPolicyCommandHandler(db, Run.Clock).Handle(command, None), command);

        public Task<int> Thresholds(UpdateThresholdsCommand command) => Act("thresholds", db => Cached
            ? new UpdateThresholdsCommandHandler(db, Run.Clock, Mutations).Handle(command, None)
            : new UpdateThresholdsCommandHandler(db, Run.Clock).Handle(command, None), command);
    }
}
