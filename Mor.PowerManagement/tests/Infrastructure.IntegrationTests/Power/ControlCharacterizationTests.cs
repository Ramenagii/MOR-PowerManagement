using Microsoft.EntityFrameworkCore;
using Mor.PowerManagement.Application.Power.Commands.AcknowledgeOutletFault;
using Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;
using Mor.PowerManagement.Application.Power.Commands.ClearOutletRecoveryState;
using Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;
using Mor.PowerManagement.Application.Power.Commands.RunStagedRestoration;
using Mor.PowerManagement.Application.Power.Commands.SetManualOverride;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

[NonParallelizable]
public class ControlCharacterizationTests
{
    private PostgresFixture _database = null!;
    private ControlScenarioRunner _run = null!;

    [OneTimeSetUp]
    public async Task OpenDatabase() => _database = await PostgresFixture.CreateAsync();

    [OneTimeTearDown]
    public async Task CloseDatabase()
    {
        if (_database is not null) await _database.DisposeAsync();
    }

    [SetUp]
    public async Task Seed()
    {
        _run = new ControlScenarioRunner(_database);
        await _run.SeedAsync();
    }

    [TearDown]
    public void PublishReplayTrace()
    {
        if (_run is null) return;
        var name = string.Concat(TestContext.CurrentContext.Test.Name
            .Select(c => char.IsLetterOrDigit(c) || c is '_' or '.' or '-' ? c : '_'));
        var directory = Path.Combine(TestContext.CurrentContext.WorkDirectory, "control-traces");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{name}.jsonl");
        File.WriteAllLines(path, _run.Traces);
        TestContext.AddTestAttachment(path, "Full baseline replay trace (symbolic GUIDs)");
    }

    private async Task<Mor.PowerManagement.Domain.Entities.Outlet> Outlet(int id = 1)
        => (await _run.OutletsAsync()).Single(x => x.Id == id);

    private Task<int> Off() => _run.ActAsync("manual-off", db =>
        new DisconnectOutletCommandHandler(db, _run.Clock).Handle(new() { OutletId = 1 }, CancellationToken.None));

    private Task<OutletActivationResult> On() => _run.ActAsync("manual-on", db =>
        new RequestOutletActivationCommandHandler(db, _run.Clock).Handle(new() { OutletId = 1 }, CancellationToken.None));

    private async Task ArmPending(string origin = "manual-off", bool closed = false)
    {
        await _run.EditAsync((outlets, _) =>
        {
            var o = outlets[0];
            o.PendingCommandId = Guid.NewGuid(); o.PendingRelayClosed = closed;
            o.PendingCommandOrigin = origin; o.PendingCommandIssuedAtUtc = _run.Clock.Peek();
            o.Status = closed ? OutletStatus.Active : OutletStatus.Disconnected;
        });
    }

    private async Task<IngestTelemetryResult> Report(bool closed, Guid? commandId, bool allReadings = true)
    {
        var sample = _run.Sample();
        return await _run.IngestAsync(sample with
        {
            Readings = allReadings ? sample.Readings : sample.Readings.Where(x => x.OutletId == 1).ToList(),
            RelayStates = [new() { OutletId = 1, RelayClosed = closed, CommandId = commandId }],
        });
    }

    [Test]
    public async Task SchemaIsolation_MigrationsAndTeardownStayInsideOwnedSchema()
    {
        var before = await _database.SnapshotOutsideRelationsAsync();
        var second = await PostgresFixture.CreateAsync();
        Assert.That(second.SchemaName, Is.Not.EqualTo(_database.SchemaName));
        Assert.That(second.IsolationEvidence.Any(x => x.Contains("pre-migration:")), Is.True);
        Assert.That(second.AppliedMigrations.Last(), Is.EqualTo("20261020090000_TelemetryMinuteRetention"));
        await second.DisposeAsync();
        Assert.That(await second.SchemaExistsAsync(), Is.False);
        Assert.That(await _database.SchemaExistsAsync(), Is.True);
        Assert.That(await _database.SnapshotOutsideRelationsAsync(), Is.EquivalentTo(before));
        TestContext.Out.WriteLine(string.Join(Environment.NewLine, second.IsolationEvidence));
    }

    [TestCase(0)]
    [TestCase(-1)]
    public async Task DuplicateOrOlderAcquisition_DoesNotStoreOrAdvanceControl(int offset)
    {
        var sample = _run.Sample(1400);
        await _run.IngestAsync(sample);
        var state = _run.Framework.Current;
        _run.Clock.AdvanceSeconds(3);
        var result = await _run.IngestAsync(sample with { AcquisitionSequence = sample.AcquisitionSequence + offset });
        Assert.That(result.ReadingsStored, Is.Zero);
        Assert.That(result.Shedding, Is.Null);
        Assert.That(_run.Framework.Current, Is.EqualTo(state));
        await using var db = _database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(5));
    }

    [Test]
    public async Task NewAcquisitionSession_PreservesExistingAcceptance()
    {
        await _run.IngestAsync(_run.Sample());
        var next = _run.Sample() with { AcquisitionSessionId = Guid.NewGuid(), AcquisitionSequence = 0 };
        Assert.That((await _run.IngestAsync(next)).ReadingsStored, Is.EqualTo(5));
        await using var db = _database.CreateMigrationContext();
        var config = await db.PowerSystemConfigs.SingleAsync();
        Assert.That(config.LastAcquisitionSessionId, Is.EqualTo(next.AcquisitionSessionId));
        Assert.That(config.LastAcquisitionSequence, Is.Zero);
    }

    [Test]
    public async Task LegacyAcquisition_MonitorsWithoutAutomaticSwitching()
    {
        for (var i = 0; i < 5; i++)
        {
            _run.Clock.AdvanceSeconds(1);
            var result = await _run.IngestAsync(_run.Sample(1400) with { AcquisitionSessionId = null, AcquisitionSequence = null });
            Assert.That(result.ReadingsStored, Is.EqualTo(5));
            Assert.That(result.Shedding!.Detail, Does.Contain("Monitoring remains active"));
        }
        Assert.That((await Outlet()).PendingCommandId, Is.Null);
        Assert.That(_run.Framework.Current.ConsecutiveOverLimitBatches, Is.Zero);
    }

    [Test]
    public async Task UnknownOutletReadings_AreIgnoredWithoutDroppingKnownOrIna()
    {
        var sample = _run.Sample();
        sample.Readings.Add(new() { OutletId = 99, PowerWatts = 999 });
        var result = await _run.IngestAsync(sample with { Ina = new() { BusV = 24, PowerW = 2 } });
        Assert.That(result.ReadingsStored, Is.EqualTo(6));
        Assert.That(result.TotalWatts, Is.EqualTo(100));
        await using var db = _database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.AnyAsync(x => x.OutletId == 99), Is.False);
        Assert.That(await db.InaReadings.CountAsync(), Is.EqualTo(1));
    }

    [TestCase("empty", 5, 0, 0)]
    [TestCase("bus", 6, 1, 0)]
    [TestCase("derived", 6, 1, 48)]
    [TestCase("power", 6, 1, 7)]
    public async Task InaPartialAndEmptyReports_PreserveExistingStorageAndMirror(string kind, int rows, int inaRows, double watts)
    {
        var ina = kind switch
        {
            "bus" => new Ina226Report { BusV = 24 },
            "derived" => new Ina226Report { BusV = 24, CurrentA = 2 },
            "power" => new Ina226Report { PowerW = 7 },
            _ => new Ina226Report(),
        };
        Assert.That((await _run.IngestAsync(_run.Sample() with { Ina = ina })).ReadingsStored, Is.EqualTo(rows));
        await using var db = _database.CreateMigrationContext();
        Assert.That(await db.InaReadings.CountAsync(), Is.EqualTo(inaRows));
        Assert.That((await Outlet(5)).CurrentWatts, Is.EqualTo(watts));
        if (inaRows > 0)
        {
            var raw = await db.InaReadings.SingleAsync();
            Assert.That(raw.PowerW, Is.EqualTo(ina.PowerW));
            Assert.That(raw.CurrentA, Is.EqualTo(ina.CurrentA));
            var mirror = (await db.TelemetryReadings.Where(x => x.OutletId == 5).OrderBy(x => x.Id).ToListAsync()).Last();
            Assert.That(mirror.EnergyKwh, Is.Zero);
        }
    }

    [Test]
    public async Task FaultFlag_RestrictsOutletsAndSkipsFramework()
    {
        var result = await _run.IngestAsync(_run.Sample(1400) with { FaultFlag = true });
        Assert.That(result.Shedding, Is.Null);
        Assert.That(result.TotalWatts, Is.Zero);
        Assert.That((await _run.OutletsAsync()).All(x => x.Status == OutletStatus.Restricted && x.FaultHold), Is.True);
        Assert.That((await _run.EventsAsync()).Select(x => x.Title), Is.EqualTo(new[] { "Hardware fault isolation" }));
        Assert.That(_run.Framework.Current, Is.EqualTo(LoadSheddingState.Initial));
    }

    [Test]
    public async Task RestrictedOutlet_RemainsRestrictedAfterRelayReport()
    {
        await _run.IngestAsync(_run.Sample() with { FaultFlag = true });
        await Report(true, null);
        Assert.That((await Outlet()).Status, Is.EqualTo(OutletStatus.Restricted));
        Assert.That((await Outlet()).FaultHold, Is.True);
    }

    [TestCase(59.999, OutletStatus.Active)]
    [TestCase(60, OutletStatus.Active)]
    [TestCase(60.001, OutletStatus.Disconnected)]
    public async Task RelayOpenReport_PreservesExisting60SecondGrace(double seconds, OutletStatus expected)
    {
        await _run.EditAsync((o, _) => o[0].CommandedAtUtc = _run.Clock.Peek());
        _run.Clock.AdvanceSeconds(seconds);
        await Report(false, null);
        Assert.That((await Outlet()).Status, Is.EqualTo(expected));
    }

    [TestCase(false, false, false)]
    [TestCase(true, true, false)]
    [TestCase(true, false, true)]
    public async Task Ack_RequiresMatchingCommandIdAndRelayState(bool matchingId, bool closed, bool acknowledged)
    {
        await ArmPending();
        var id = (await Outlet()).PendingCommandId;
        await Report(closed, matchingId ? id : Guid.NewGuid());
        Assert.That((await Outlet()).PendingCommandAcknowledgedAtUtc.HasValue, Is.EqualTo(acknowledged));
        Assert.That((await Outlet()).PendingCommandId, Is.EqualTo(id));
    }

    [Test]
    public async Task RepeatedMatchingAck_PreservesFirstAcknowledgementTime()
    {
        await ArmPending("automatic-shed");
        var id = (await Outlet()).PendingCommandId;
        await Report(false, id);
        var first = (await Outlet()).PendingCommandAcknowledgedAtUtc;
        _run.Clock.AdvanceSeconds(0.25);
        await Report(false, id);
        Assert.That((await Outlet()).PendingCommandAcknowledgedAtUtc, Is.EqualTo(first));
        // Current code resets this separate timer even for a repeated ACK.
        Assert.That((await Outlet()).NextRecoveryAtUtc, Is.EqualTo(_run.Clock.Peek().AddSeconds(55)));
    }

    [Test]
    public async Task PendingCommand_ClearsOnlyAfterAllRequiredPostSettleSamples()
    {
        await ArmPending();
        var id = (await Outlet()).PendingCommandId;
        await Report(false, id);
        _run.Clock.AdvanceSeconds(0.5);
        await Report(false, id);
        Assert.That((await Outlet()).PendingCommandId, Is.EqualTo(id), "strictly after, not at 500 ms");
        _run.Clock.AdvanceSeconds(0.001);
        await Report(false, id, false);
        Assert.That((await Outlet()).PendingCommandId, Is.EqualTo(id), "other known timestamps remain at boundary");
        await Report(false, id);
        Assert.That((await Outlet()).PendingCommandId, Is.Null);
        Assert.That((await Outlet()).PendingCommandOrigin, Is.Null);
        Assert.That((await Outlet()).PendingCommandAcknowledgedAtUtc, Is.Null);
    }

    [Test]
    public async Task MissingAck_AfterFiveSeconds_EmitsReviewOnceAndPauses()
    {
        await ArmPending();
        _run.Clock.AdvanceSeconds(5);
        await Report(false, null);
        Assert.That((await Outlet()).CommandNeedsReview, Is.False);
        _run.Clock.AdvanceSeconds(0.001);
        var result = await Report(false, null);
        Assert.That((await Outlet()).CommandNeedsReview, Is.True);
        Assert.That(result.Shedding!.Detail, Does.Contain("Admin review"));
        await Report(false, null);
        Assert.That((await _run.EventsAsync()).Count(x => x.Title == "Relay response needs review"), Is.EqualTo(1));
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task PendingOrReviewCommand_BlocksFurtherAutomaticSwitching(bool review)
    {
        await ArmPending();
        if (review) await _run.EditAsync((o, _) => { o[0].PendingCommandId = null; o[0].CommandNeedsReview = true; });
        var result = await _run.IngestAsync(_run.Sample(1400));
        Assert.That(result.Shedding!.Action, Is.EqualTo("None"));
        Assert.That(_run.Framework.Current.ConsecutiveOverLimitBatches, Is.Zero);
        Assert.That(result.Shedding.Detail, Does.Contain(review ? "Admin review" : "acknowledgement"));
    }

    [TestCase(true, 0)]
    [TestCase(false, 30)]
    [TestCase(false, 30.001)]
    public async Task MissingOrStaleInputs_PauseAutomaticSwitching(bool missing, double age)
    {
        await _run.EditAsync((o, _) => o[1].LastSeen = missing ? null : _run.Clock.Peek().AddSeconds(-age));
        var sample = _run.Sample(1400);
        var result = await _run.IngestAsync(sample with { Readings = sample.Readings.Where(x => x.OutletId != 2).ToList() });
        Assert.That(result.Shedding!.Detail.Contains("Fresh readings are required"), Is.EqualTo(missing || age > 30));
        Assert.That(_run.Framework.Current.ConsecutiveOverLimitBatches, Is.EqualTo(missing || age > 30 ? 0 : 1));
    }

    [Test]
    public async Task RecoveryTrial_UsesThreeFreshOverLimitAcquisitions()
    {
        await _run.EditAsync((o, _) => { o[0].RecoveryTrialPending = true; o[0].AutomaticRecoveryAttempts = 1; });
        var first = _run.Sample(1300);
        await _run.IngestAsync(first);
        await _run.IngestAsync(first);
        Assert.That((await Outlet()).RecoveryTrialOverLimitBatches, Is.EqualTo(1));
        Assert.That((await _run.IngestAsync(_run.Sample(1300))).Shedding!.Action, Is.EqualTo("None"));
        var last = await _run.IngestAsync(_run.Sample(1300));
        Assert.That(last.Shedding!.Action, Is.EqualTo("Shed"));
        Assert.That(last.Shedding.OutletId, Is.EqualTo(1));
        Assert.That((await Outlet()).PendingCommandOrigin, Is.EqualTo("recovery-retry-off"));
        Assert.That((await Outlet()).RecoveryLockout, Is.False);
    }

    [Test]
    public async Task RecoveryTrial_ReopensSameOutlet_AndLocksOutAfterFifthAttempt()
    {
        Guid? previousCommand = null;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            await _run.EditAsync((o, _) =>
            {
                o[0].Status = OutletStatus.Disconnected;
                o[0].NextRecoveryAtUtc = _run.Clock.Peek();
            });
            var restore = await _run.IngestAsync(_run.Sample(0));
            Assert.That(restore.Shedding!.Action, Is.EqualTo("Restore"));
            var id = (await Outlet()).PendingCommandId;
            Assert.That(id, Is.Not.Null.And.Not.EqualTo(previousCommand));
            Assert.That((await Outlet()).AutomaticRecoveryAttempts, Is.EqualTo(attempt));
            await Report(true, id);
            _run.Clock.AdvanceSeconds(0.501);
            // Clear the pending ON command and count the first trial sample.
            var over = _run.Sample(1300) with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = id }] };
            await _run.IngestAsync(over);
            await _run.IngestAsync(_run.Sample(1300));
            var failed = await _run.IngestAsync(_run.Sample(1300));
            Assert.That(failed.Shedding!.OutletId, Is.EqualTo(1));
            Assert.That(failed.Shedding.Action, Is.EqualTo("Shed"));
            var opened = await Outlet();
            Assert.That(opened.Status, Is.EqualTo(OutletStatus.Disconnected));
            Assert.That(opened.RecoveryLockout, Is.EqualTo(attempt == 5));
            Assert.That(opened.PendingCommandId, Is.Not.EqualTo(id));
            previousCommand = opened.PendingCommandId;
            await Report(false, previousCommand);
            _run.Clock.AdvanceSeconds(0.501);
            await Report(false, previousCommand);
        }
        _run.Clock.AdvanceSeconds(55);
        Assert.That((await _run.IngestAsync(_run.Sample(0))).Shedding!.Action, Is.EqualTo("None"));
        Assert.That((await _run.EventsAsync()).Count(x => x.Title == "Recovery locked out"), Is.EqualTo(1));
    }

    [Test]
    public async Task ManualCommands_PreservePendingHoldAndClearanceRules()
    {
        await _run.EditAsync((o, _) => o[0].CurrentWatts = 123);
        await Off();
        var off = await Outlet();
        Assert.That(off.ManualHold, Is.True);
        Assert.That(off.CurrentWatts, Is.EqualTo(123));
        await Off();
        Assert.That((await Outlet()).PendingCommandId, Is.EqualTo(off.PendingCommandId));
        Assert.That((await On()).PolicyCode, Is.EqualTo("COMMAND_PENDING"));
        await _run.EditAsync((o, _) =>
        {
            o[0].FaultHold = true; o[0].RecoveryLockout = true;
            o[0].AutomaticRecoveryAttempts = 5; o[0].CommandNeedsReview = true;
        });
        await _run.ActAsync("clear-recovery", db => new ClearOutletRecoveryStateCommandHandler(db, _run.Clock)
            .Handle(new(1), CancellationToken.None));
        var clear = await Outlet();
        Assert.That(clear.ManualHold && clear.FaultHold, Is.True);
        Assert.That(clear.PendingCommandId, Is.Null);
        Assert.That(clear.RecoveryLockout || clear.CommandNeedsReview, Is.False);
        Assert.That(clear.AutomaticRecoveryAttempts, Is.Zero);
        Assert.That((await On()).PolicyCode, Is.EqualTo("HOLD"));
        await _run.ActAsync("ack-fault", db => new AcknowledgeOutletFaultCommandHandler(db, _run.Clock)
            .Handle(new(1), CancellationToken.None));
        Assert.That((await Outlet()).Status, Is.EqualTo(OutletStatus.Disconnected));
        Assert.That((await On()).Allowed, Is.False, "2000 W allowance exceeds system limit");
        await _run.EditAsync((o, _) => o[0].AllowanceWatts = 300);
        Assert.That((await On()).Allowed, Is.True);
        Assert.That((await Outlet()).ManualHold, Is.False);
        Assert.That((await Outlet()).PendingCommandOrigin, Is.EqualTo("manual-on"));
    }

    [TestCase(false, 100, "Restore")]
    [TestCase(false, 1250, "Restore")]
    [TestCase(false, 1300, "None")]
    [TestCase(true, 100, "hold")]
    public async Task ForcedRestoration_SkipsWaitsButPreservesExistingSafetyChecks(bool hold, double watts, string expected)
    {
        await _run.EditAsync((o, _) =>
        {
            o[0].Status = OutletStatus.Disconnected; o[0].FaultHold = hold;
            o[1].CurrentWatts = watts;
        });
        _run.Framework.Update(s => s with
        {
            ShedLedger = [new(1, LoadTier.Nonessential, 300, _run.Clock.Peek())],
            ManualOverride = true, LastReconnectUtc = _run.Clock.Peek(),
        });
        async Task<StagedRestorationResult> Force() => await _run.ActAsync("force-restore", db =>
            new RunStagedRestorationCommandHandler(db, _run.Framework, _run.Clock)
                .Handle(new() { Force = true }, CancellationToken.None));
        if (hold)
            Assert.ThrowsAsync<InvalidOperationException>(async () => await Force());
        else
            Assert.That((await Force()).Action, Is.EqualTo(expected));
    }

    [TestCase(299.999, false)]
    [TestCase(300, false)]
    [TestCase(300.001, true)]
    public async Task WarningEvent_UsesLatestGlobalEventAndFiveMinuteBoundary(double seconds, bool repeated)
    {
        await _run.IngestAsync(_run.Sample(1100));
        _run.Clock.AdvanceSeconds(seconds);
        await _run.IngestAsync(_run.Sample(1100));
        Assert.That((await _run.EventsAsync()).Count(x => x.Title == "System state: Warning"), Is.EqualTo(repeated ? 2 : 1));
        _run.Clock.AdvanceSeconds(0.001);
        await _run.ActAsync("override", db => new SetManualOverrideCommandHandler(db, _run.Framework, _run.Clock)
            .Handle(new() { Enabled = true }, CancellationToken.None));
        _run.Clock.AdvanceSeconds(0.001);
        await _run.IngestAsync(_run.Sample(1100));
        Assert.That((await _run.EventsAsync()).Count(x => x.Title == "System state: Warning"), Is.EqualTo(repeated ? 3 : 2));
    }

    [Test]
    public async Task EnergyValues_AreStoredWithoutIntegrationOrReinterpretation()
    {
        foreach (var energy in new[] { 12.345, 1.25, 0.0 })
        {
            _run.Clock.AdvanceSeconds(10);
            var sample = _run.Sample();
            await _run.IngestAsync(sample with { Readings = sample.Readings.Select(x => x with { EnergyKwh = energy }).ToList() });
        }
        await using var db = _database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.Where(x => x.OutletId == 1).OrderBy(x => x.Id)
            .Select(x => x.EnergyKwh).ToListAsync(), Is.EqualTo(new[] { 12.345, 1.25, 0.0 }));
    }

    [Test]
    public async Task SelectiveResponse_UsesOneCandidateAndManualHoldDespiteCount()
    {
        await _run.EditAsync((o, _) => { o[0].CurrentWatts = 500; o[1].CurrentWatts = 300; });
        var command = new ApplySelectiveResponseCommand { Count = 5, ManualOverride = true };
        var result = await _run.ActAsync("selective-response", db =>
            new ApplySelectiveResponseCommandHandler(db, _run.Framework, _run.Clock).Handle(command, CancellationToken.None), command);
        Assert.That(result.ShedOutletIds, Is.EqualTo(new[] { 1 }));
        Assert.That(result.TotalWatts, Is.EqualTo(300));
        Assert.That(result.ManualOverrideActive, Is.True);
        Assert.That((await Outlet()).ManualHold, Is.True);
        Assert.That((await Outlet()).PendingCommandOrigin, Is.EqualTo("manual-off"));
        Assert.That(_run.Framework.Current.ShedLedger.Single().WattsAtShed, Is.EqualTo(500));
    }

    [Test]
    public async Task ReplayTrace_IsDeterministicAndRetainsGuidIdentityAndEventOrder()
    {
        async Task<string[]> Replay()
        {
            await _run.IngestAsync(_run.Sample(1400));
            _run.Clock.AdvanceSeconds(3);
            await _run.IngestAsync(_run.Sample(1400));
            var id = (await Outlet()).PendingCommandId;
            await Report(false, Guid.Parse("22222222-2222-2222-2222-222222222222"));
            await Report(false, id);
            _run.Clock.AdvanceSeconds(0.501);
            await Report(false, id);
            return _run.Traces.ToArray();
        }
        var first = await Replay();
        var events = await _run.EventsAsync();
        Assert.That(events.Select(x => x.Title), Is.EqualTo(new[]
        {
            "System state: Critical", "Priority-based load shed",
        }));
        Assert.That(events[1].Detail, Does.Contain("at least 3 s"));
        Assert.That(first[1], Does.Contain("guid-2"));
        Assert.That(first[2], Does.Contain("guid-4"));
        _run = new ControlScenarioRunner(_database);
        await _run.SeedAsync();
        Assert.That(await Replay(), Is.EqualTo(first));
    }
}
