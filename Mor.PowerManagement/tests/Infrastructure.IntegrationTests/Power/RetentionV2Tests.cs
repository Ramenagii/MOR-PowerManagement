using System.Data.Common;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Mor.PowerManagement.Infrastructure.Power.History;
using static Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support.RetentionRig;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>PLAN-0001 Spec F: seven-day raw retention and resumable minute compaction.</summary>
[NonParallelizable]
public class RetentionV2Tests
{
    private const string Telemetry = TelemetryCompactionCheckpoint.TelemetryStream;
    private const string Ina = TelemetryCompactionCheckpoint.InaStream;
    private static readonly TimeSpan Day = TimeSpan.FromDays(1);
    private static readonly DateTimeOffset Never = DateTimeOffset.MaxValue;

    private static Dictionary<string, string?> Tuning(int? batchRows = null, int? pruneRows = null, int? maxBatches = null)
    {
        var settings = new Dictionary<string, string?>();
        if (batchRows is { } b) settings[$"{RetentionV2Options.TuningSection}:CompactionBatchRows"] = b.ToString();
        if (pruneRows is { } p) settings[$"{RetentionV2Options.TuningSection}:PruneBatchRows"] = p.ToString();
        if (maxBatches is { } m) settings[$"{RetentionV2Options.TuningSection}:MaxBatchesPerRun"] = m.ToString();
        return settings;
    }

    // ---- Flags --------------------------------------------------------------

    [TestCase(false, false, false, false)]
    [TestCase(false, true, true, false)]
    [TestCase(true, true, true, false)]
    [TestCase(true, true, false, true)]
    [TestCase(true, false, true, true)]
    [TestCase(true, false, false, true)]
    public void Flags_RetentionV2RequiresRuntimeIngestAndBatchPersistence(bool v2, bool runtime, bool batched, bool rejected)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [RetentionV2Options.EnabledKey] = v2.ToString(),
            [HistoryPersistenceOptions.RuntimeIngestEnabledKey] = runtime.ToString(),
            [HistoryPersistenceOptions.BatchPersistenceEnabledKey] = batched.ToString(),
        }).Build();
        var options = RetentionV2Options.FromConfiguration(configuration);
        Assert.That(options.Enabled, Is.EqualTo(v2));
        if (rejected)
            Assert.That(() => options.Validate(configuration), Throws.InvalidOperationException.With.Message.Contains(RetentionV2Options.EnabledKey));
        else
            Assert.That(() => options.Validate(configuration), Throws.Nothing);
    }

    [TestCase(true, false)]
    [TestCase(false, false)]
    public async Task Flags_UnsupportedCombination_StopsHostConstruction(bool runtime, bool batched)
    {
        await using var db = await PostgresFixture.CreateAsync();
        var run = new ControlScenarioRunner(db);
        Assert.That(() => BuildHost(db, run, v2: true, runtime: runtime, batched: batched),
            Throws.InvalidOperationException.With.Message.Contains(RetentionV2Options.EnabledKey));
    }

    [Test]
    public void Flags_DefaultIsOff_AndLegacyOverridesAreReportedByNameOnly()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Telemetry:RawRetentionHours"] = "48",
        }).Build();
        var options = RetentionV2Options.FromConfiguration(configuration);
        Assert.That(options.Enabled, Is.False);
        Assert.That(options.IgnoredLegacyKeys, Is.EqualTo(new[] { "Telemetry:RawRetentionHours" }));
    }

    [Test]
    public async Task FlagOff_LegacyMaintenanceUnchanged_AndNothingOfV2ScopeIsDeleted()
    {
        await using var rig = await RetentionRig.Create(v2: false);
        Assert.That(rig.App.Services.GetServices<IHistoryMaintenance>().Select(j => j.Name), Is.EqualTo(new[] { "legacy-retention" }));
        Assert.That(rig.App.Services.GetService<TelemetryCompactionRunner>(), Is.Null);
        await rig.AddEventsAsync(Enumerable.Range(0, 30).Select(i => rig.Now - TimeSpan.FromDays(40 + i)).ToArray());
        await rig.AddReadingsAsync(Reading(1, rig.Now - TimeSpan.FromHours(7), 100, 1), Reading(1, rig.Now - TimeSpan.FromHours(1), 100, 2));

        await rig.Coordinator.InitializeAsync();

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.PowerEvents.CountAsync(), Is.EqualTo(30), "flag off: zero event deletes");
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(1), "legacy six-hour compaction still runs");
        Assert.That((await rig.FiveMinuteRollupsAsync()).Sum(r => r.SampleCount), Is.EqualTo(1));
        Assert.That(await db.TelemetryMinuteRollups.CountAsync(), Is.Zero);
        Assert.That(await db.TelemetryCompactionCheckpoints.CountAsync(), Is.Zero);
    }

    [Test]
    public async Task FlagOn_ReplacesLegacyMaintenance_WithV2InsideTheSharedWindow()
    {
        await using var rig = await RetentionRig.Create();
        Assert.That(rig.App.Services.GetServices<IHistoryMaintenance>().Select(j => j.Name), Is.EqualTo(new[] { "retention-v2" }));
        await rig.AddReadingsAsync(Reading(1, rig.Now - TimeSpan.FromHours(7), 100, 1), Reading(1, rig.Now - Day * 8, 100, 0.5));

        await rig.Coordinator.InitializeAsync();

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.Select(r => r.EnergyKwh).ToListAsync(), Is.EqualTo(new[] { 1.0 }), "seven-hour-old raw is kept");
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(1));
    }

    // ---- Compaction ---------------------------------------------------------

    [Test]
    public async Task Compaction_KeepsRawAtLeastSevenDays_AndNeverSplitsTheBoundaryMinute()
    {
        await using var rig = await RetentionRig.Create();
        rig.Run.Clock.SetUtcNow(ControlledTimeProvider.DefaultStart.AddSeconds(30));
        var sevenDaysAgo = rig.Now - TimeSpan.FromDays(7);
        await rig.AddReadingsAsync(
            Reading(1, sevenDaysAgo.AddSeconds(-31), 100, 1.0),
            Reading(1, sevenDaysAgo.AddSeconds(-30), 100, 1.1),
            Reading(1, sevenDaysAgo.AddSeconds(-1), 100, 1.2),
            Reading(1, sevenDaysAgo.AddDays(1).AddHours(-1), 100, 1.3));

        var outcome = await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default);

        Assert.That(outcome, Is.EqualTo(new CompactionOutcome(1, 1, CompactionState.Complete)));
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.OrderBy(r => r.EnergyKwh).Select(r => r.EnergyKwh).ToListAsync(), Is.EqualTo(new[] { 1.1, 1.2, 1.3 }));
        var minute = await db.TelemetryMinuteRollups.SingleAsync();
        Assert.That(minute.BucketStart, Is.EqualTo(sevenDaysAgo.AddSeconds(-90)));
        var checkpoint = await db.TelemetryCompactionCheckpoints.SingleAsync();
        Assert.That(checkpoint.LastCutoffUtc, Is.EqualTo(sevenDaysAgo.AddSeconds(-30)));
        Assert.That(checkpoint.MinuteCoverageFromUtc, Is.EqualTo(sevenDaysAgo.AddSeconds(-31)));
        Assert.That(checkpoint.LastCompactedAtUtc, Is.EqualTo(rig.Now));
    }

    [Test]
    public async Task Compaction_MinuteAndFiveMinuteSummaries_AreExact()
    {
        await using var rig = await RetentionRig.Create();
        var m0 = rig.Now - Day * 8;
        await rig.AddReadingsAsync(
            Reading(1, m0, 100, 1.00, volts: 230, amps: 0.4),
            Reading(1, m0.AddSeconds(20), 300, 1.02, volts: 232, amps: 1.3),
            Reading(1, m0.AddSeconds(40), 200, 1.05, volts: 231, amps: 0.9),
            Reading(1, m0.AddSeconds(60), 50, 1.06, volts: 229, amps: 0.2),
            Reading(2, m0.AddSeconds(10), 10, 5.00),
            // Equal timestamps: first/last resolve by acquisition then sample ordinal.
            Reading(3, m0, 7, 2.0, acquisition: 7, sample: 1),
            Reading(3, m0, 7, 1.9, acquisition: 7, sample: 0));

        var outcome = await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default);

        Assert.That(outcome, Is.EqualTo(new CompactionOutcome(7, 1, CompactionState.Complete)));
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.Zero);
        var minutes = await db.TelemetryMinuteRollups.AsNoTracking().OrderBy(r => r.OutletId).ThenBy(r => r.BucketStart).ToListAsync();
        Assert.That(minutes.Select(r => (r.OutletId, r.BucketStart, r.SampleCount)),
            Is.EqualTo(new[] { (1, m0, 3L), (1, m0.AddMinutes(1), 1L), (2, m0, 1L), (3, m0, 2L) }));
        var first = minutes[0];
        Assert.Multiple(() =>
        {
            Assert.That(first.VoltageSum, Is.EqualTo(693).Within(1e-9));
            Assert.That(first.CurrentAmpsSum, Is.EqualTo(2.6).Within(1e-9));
            Assert.That(first.PowerWattsSum, Is.EqualTo(600).Within(1e-9));
            Assert.That((first.MinVoltage, first.MaxVoltage), Is.EqualTo((230.0, 232.0)));
            Assert.That((first.MinCurrentAmps, first.MaxCurrentAmps), Is.EqualTo((0.4, 1.3)));
            Assert.That((first.MinPowerWatts, first.MaxPowerWatts), Is.EqualTo((100.0, 300.0)));
            Assert.That((first.FirstEnergyKwh, first.FirstSampleAt), Is.EqualTo((1.00, m0)));
            Assert.That((first.LastEnergyKwh, first.LatestSampleAt), Is.EqualTo((1.05, m0.AddSeconds(40))));
            Assert.That(first.MaxEnergyKwh, Is.EqualTo(1.05));
            Assert.That((minutes[3].FirstEnergyKwh, minutes[3].LastEnergyKwh), Is.EqualTo((1.9, 2.0)));
        });

        var five = await rig.FiveMinuteRollupsAsync();
        Assert.That(five.Select(r => (r.OutletId, r.BucketStart, r.SampleCount)), Is.EqualTo(new[] { (1, m0, 4L), (2, m0, 1L), (3, m0, 2L) }));
        Assert.Multiple(() =>
        {
            Assert.That(five[0].PowerWattsSum / five[0].SampleCount, Is.EqualTo(162.5).Within(1e-9), "weighted mean");
            Assert.That(five[0].PeakPowerWatts, Is.EqualTo(300));
            Assert.That((five[0].MinVoltage, five[0].MaxVoltage), Is.EqualTo((229.0, 232.0)));
            Assert.That((five[0].FirstEnergyKwh, five[0].LastEnergyKwh), Is.EqualTo((1.00, 1.06)));
            Assert.That((five[0].FirstSampleAt, five[0].LatestSampleAt), Is.EqualTo((m0, m0.AddSeconds(60))));
        });

        var checkpoint = await db.TelemetryCompactionCheckpoints.SingleAsync(c => c.Stream == Telemetry);
        Assert.That((checkpoint.CompactedRows, checkpoint.CompactedBatches, checkpoint.LastBatchRows), Is.EqualTo((7L, 1L, 7)));
    }

    [Test]
    public async Task Compaction_MinuteSplitAcrossBatches_AndLateRows_MergeExactlyOnce()
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(batchRows: 3));
        var m0 = rig.Now - Day * 8;
        await rig.AddReadingsAsync(Enumerable.Range(1, 10)
            .Select(i => Reading(1, m0.AddSeconds(i * 5), i * 10, 1 + i * 0.01)).ToArray());

        var outcome = await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default);
        Assert.That(outcome, Is.EqualTo(new CompactionOutcome(10, 4, CompactionState.Complete)));

        // A late upload for the already-compacted minute merges into it.
        await rig.AddReadingsAsync(Reading(1, m0.AddSeconds(1), 1000, 0.99));
        Assert.That(await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Is.EqualTo(new CompactionOutcome(1, 1, CompactionState.Complete)));

        await using var db = rig.Database.CreateMigrationContext();
        var minute = await db.TelemetryMinuteRollups.AsNoTracking().SingleAsync();
        Assert.Multiple(() =>
        {
            Assert.That(minute.SampleCount, Is.EqualTo(11));
            Assert.That(minute.PowerWattsSum, Is.EqualTo(1550).Within(1e-9));
            Assert.That((minute.MinPowerWatts, minute.MaxPowerWatts), Is.EqualTo((10.0, 1000.0)));
            Assert.That((minute.FirstEnergyKwh, minute.FirstSampleAt), Is.EqualTo((0.99, m0.AddSeconds(1))));
            Assert.That((minute.LastEnergyKwh, minute.LatestSampleAt), Is.EqualTo((1.10, m0.AddSeconds(50))));
        });
        var five = (await rig.FiveMinuteRollupsAsync()).Single();
        Assert.That((five.SampleCount, five.PeakPowerWatts, five.FirstEnergyKwh, five.LastEnergyKwh), Is.EqualTo((11L, 1000.0, 0.99, 1.10)));
        Assert.That((await db.TelemetryCompactionCheckpoints.SingleAsync()).CompactedRows, Is.EqualTo(11));
    }

    [Test]
    public async Task Compaction_FailureBeforeCommit_RollsBackDeleteSummariesAndProgress_ThenRetriesOnce()
    {
        var fault = new FailCheckpointUpdate();
        await using var rig = await RetentionRig.Create(interceptor: fault);
        var m0 = rig.Now - Day * 9;
        await rig.AddReadingsAsync(Enumerable.Range(0, 6).Select(i => Reading(1 + i % 2, m0.AddSeconds(i), 100, 1 + i)).ToArray());

        fault.Armed = true;
        Assert.That(() => rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Throws.TypeOf<IOException>());

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(6));
        Assert.That(await db.TelemetryMinuteRollups.CountAsync(), Is.Zero);
        Assert.That(await rig.FiveMinuteRollupsAsync(), Is.Empty);
        Assert.That(await db.TelemetryCompactionCheckpoints.CountAsync(), Is.Zero);

        Assert.That(await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Is.EqualTo(new CompactionOutcome(6, 1, CompactionState.Complete)));
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.Zero);
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(6));
        Assert.That((await rig.FiveMinuteRollupsAsync()).Sum(r => r.SampleCount), Is.EqualTo(6));
    }

    [Test]
    public async Task Compaction_LostCommitResponse_RetryFindsNothingToDoubleCount()
    {
        var fault = new LoseCommitResponse();
        await using var rig = await RetentionRig.Create(interceptor: fault);
        var m0 = rig.Now - Day * 9;
        await rig.AddReadingsAsync(Enumerable.Range(0, 4).Select(i => Reading(1, m0.AddSeconds(i), 100, 1 + i)).ToArray());

        fault.Armed = true;
        Assert.That(() => rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Throws.TypeOf<IOException>());
        Assert.That(await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Is.EqualTo(new CompactionOutcome(0, 0, CompactionState.Complete)));

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(4));
        Assert.That((await rig.FiveMinuteRollupsAsync()).Sum(r => r.SampleCount), Is.EqualTo(4));
        Assert.That((await db.TelemetryCompactionCheckpoints.SingleAsync()).CompactedRows, Is.EqualTo(4));
    }

    [Test]
    public async Task Compaction_StreamHeldByAnotherRunner_IsSkippedWithoutChanges()
    {
        await using var rig = await RetentionRig.Create();
        var m0 = rig.Now - Day * 8;
        await rig.AddReadingsAsync(Reading(1, m0, 100, 1), Reading(1, m0.AddSeconds(1), 100, 2));
        await using var holder = rig.Database.CreateMigrationContext();
        await holder.Database.ExecuteSqlRawAsync("""
            INSERT INTO "TelemetryCompactionCheckpoints" ("Stream", "CompactedRows", "CompactedBatches", "LastBatchRows") VALUES ('telemetry', 0, 0, 0)
            """);
        await using (var held = await holder.Database.BeginTransactionAsync())
        {
            await holder.Database.ExecuteSqlRawAsync("""SELECT 1 FROM "TelemetryCompactionCheckpoints" WHERE "Stream" = 'telemetry' FOR UPDATE""");
            var busy = await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.That(busy, Is.EqualTo(new CompactionOutcome(0, 0, CompactionState.Busy)));
            await held.RollbackAsync();
        }

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(2));
        Assert.That(await rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default), Is.EqualTo(new CompactionOutcome(2, 1, CompactionState.Complete)));
    }

    [Test]
    public async Task Compaction_ConcurrentRunners_CountEveryRowExactlyOnce()
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(batchRows: 2, maxBatches: 100));
        var m0 = rig.Now - Day * 8;
        await rig.AddReadingsAsync(Enumerable.Range(0, 40).Select(i => Reading(1 + i % 4, m0.AddSeconds(i * 7), i, i)).ToArray());

        var runs = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => Task.Run(() => rig.Compaction.CompactAsync(Telemetry, rig.Now, Never, default))));

        Assert.That(runs.Sum(r => r.Rows), Is.EqualTo(40));
        Assert.That(runs.Count(r => r.State == CompactionState.Complete), Is.GreaterThanOrEqualTo(1));
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.Zero);
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(40));
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.PowerWattsSum), Is.EqualTo(Enumerable.Range(0, 40).Sum()).Within(1e-9));
        Assert.That((await rig.FiveMinuteRollupsAsync()).Sum(r => r.SampleCount), Is.EqualTo(40));
        Assert.That((await db.TelemetryCompactionCheckpoints.SingleAsync()).CompactedRows, Is.EqualTo(40));
    }

    [Test]
    public async Task Compaction_Ina226_KeepsPerFieldCounts_AndNullsMergeAsNoContribution()
    {
        await using var rig = await RetentionRig.Create();
        var m0 = rig.Now - Day * 8;
        await rig.AddInaAsync(
            new InaReading { Timestamp = m0, BusVoltageV = 5.0, CurrentA = 0.1 },
            new InaReading { Timestamp = m0.AddSeconds(1), BusVoltageV = 5.2 },
            new InaReading { Timestamp = m0.AddSeconds(2), CurrentA = 0.3 },
            new InaReading { Timestamp = rig.Now - Day, BusVoltageV = 4.9 });

        Assert.That(await rig.Compaction.CompactAsync(Ina, rig.Now, Never, default), Is.EqualTo(new CompactionOutcome(3, 1, CompactionState.Complete)));
        await using var db = rig.Database.CreateMigrationContext();
        var minute = await db.InaMinuteRollups.AsNoTracking().SingleAsync();
        Assert.Multiple(() =>
        {
            Assert.That(minute.SampleCount, Is.EqualTo(3));
            Assert.That((minute.BusVoltageVCount, minute.BusVoltageVSum, minute.MinBusVoltageV, minute.MaxBusVoltageV), Is.EqualTo((2L, (double?)10.2, (double?)5.0, (double?)5.2)));
            Assert.That((minute.ShuntVoltageMvCount, minute.ShuntVoltageMvSum, minute.MinShuntVoltageMv, minute.MaxShuntVoltageMv), Is.EqualTo((0L, (double?)null, (double?)null, (double?)null)));
            Assert.That(minute.CurrentACount, Is.EqualTo(2));
            Assert.That(minute.CurrentASum, Is.EqualTo(0.4).Within(1e-9));
            Assert.That((minute.PowerWCount, minute.PowerWSum), Is.EqualTo((0L, (double?)null)));
        });

        await rig.AddInaAsync(new InaReading { Timestamp = m0.AddSeconds(30), ShuntVoltageMv = 1.5, PowerW = 0.5 });
        await rig.Compaction.CompactAsync(Ina, rig.Now, Never, default);
        minute = await db.InaMinuteRollups.AsNoTracking().SingleAsync();
        Assert.Multiple(() =>
        {
            Assert.That(minute.SampleCount, Is.EqualTo(4));
            Assert.That((minute.BusVoltageVCount, minute.BusVoltageVSum), Is.EqualTo((2L, (double?)10.2)));
            Assert.That((minute.ShuntVoltageMvCount, minute.ShuntVoltageMvSum, minute.MinShuntVoltageMv, minute.MaxShuntVoltageMv), Is.EqualTo((1L, (double?)1.5, (double?)1.5, (double?)1.5)));
            Assert.That((minute.PowerWCount, minute.PowerWSum), Is.EqualTo((1L, (double?)0.5)));
            Assert.That((minute.FirstSampleAt, minute.LatestSampleAt), Is.EqualTo((m0, m0.AddSeconds(30))));
        });
        Assert.That(await db.InaReadings.CountAsync(), Is.EqualTo(1), "one-day-old INA226 sample stays raw");
        Assert.That((await db.TelemetryCompactionCheckpoints.SingleAsync(c => c.Stream == Ina)).CompactedRows, Is.EqualTo(4));
    }

    [Test]
    public async Task Maintenance_BudgetOrDeadline_DefersTheRest_AndLaterWindowsCatchUp()
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(batchRows: 5, maxBatches: 1));
        var m0 = rig.Now - Day * 10;
        await rig.AddReadingsAsync(Enumerable.Range(0, 12).Select(i => Reading(1, m0.AddMinutes(i), 100, i)).ToArray());

        Assert.That(await rig.Compaction.CompactAsync(Telemetry, rig.Now, deadlineUtc: rig.Now, default), Is.EqualTo(new CompactionOutcome(0, 0, CompactionState.Deferred)));

        await using var db = rig.Database.CreateMigrationContext();
        var remaining = new List<int>();
        for (var window = 0; window < 3; window++)
        {
            await rig.Coordinator.InitializeAsync();
            remaining.Add(await db.TelemetryReadings.CountAsync());
        }

        Assert.That(remaining, Is.EqualTo(new[] { 7, 2, 0 }));
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(12));
    }

    // ---- 30-day summary and event retention ---------------------------------

    [Test]
    public async Task SummaryPrune_KeepsThirtyDays_InBoundedBatches()
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(pruneRows: 1, maxBatches: 2));
        var cutoff = rig.Now - TimeSpan.FromDays(30);
        await using var db = rig.Database.CreateMigrationContext();
        foreach (var at in new[] { cutoff.AddMinutes(-3), cutoff.AddMinutes(-2), cutoff.AddMinutes(-1), cutoff, cutoff.AddDays(1) })
        {
            db.TelemetryMinuteRollups.Add(new TelemetryMinuteRollup { OutletId = 1, BucketStart = at, SampleCount = 1, FirstSampleAt = at, LatestSampleAt = at });
            db.InaMinuteRollups.Add(new InaMinuteRollup { BucketStart = at, SampleCount = 1, FirstSampleAt = at, LatestSampleAt = at });
        }
        await db.SaveChangesAsync();
        foreach (var at in new[] { cutoff.AddMinutes(-5), cutoff })
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO "TelemetryReadingRollups" ("OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                    "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt")
                VALUES (1, {at}, 1, 230, 1, 100, 230, 230, 100, 1, {at}, 1, {at})
                """);
        }

        var first = await rig.Compaction.PruneSummariesAsync(rig.Now, Never, default);
        Assert.That(first, Is.EqualTo(new SummaryPruneOutcome(2, 2, 1, false)), "two one-row batches per run");
        var second = await rig.Compaction.PruneSummariesAsync(rig.Now, Never, default);
        Assert.That(second, Is.EqualTo(new SummaryPruneOutcome(1, 1, 0, true)));

        Assert.That(await db.TelemetryMinuteRollups.Select(r => r.BucketStart).OrderBy(b => b).ToListAsync(), Is.EqualTo(new[] { cutoff, cutoff.AddDays(1) }));
        Assert.That(await db.InaMinuteRollups.CountAsync(), Is.EqualTo(2));
        Assert.That((await rig.FiveMinuteRollupsAsync()).Select(r => r.BucketStart), Is.EqualTo(new[] { cutoff }));
    }

    [Test]
    public async Task Events_StoredThirtyDays_ThenPruned()
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(pruneRows: 2));
        var now = rig.Now;
        await rig.AddEventsAsync(Enumerable.Range(0, 20).Select(i => now - TimeSpan.FromMinutes(i)).ToArray());
        await rig.AddEventsAsync(
            now - TimeSpan.FromDays(29) - TimeSpan.FromHours(23),
            now - TimeSpan.FromDays(30),
            now - TimeSpan.FromDays(30) - TimeSpan.FromSeconds(1),
            now - TimeSpan.FromDays(31),
            now - TimeSpan.FromDays(45),
            now - TimeSpan.FromDays(90));

        await rig.Coordinator.InitializeAsync();

        var kept = (await rig.Run.EventsAsync()).Select(e => now - e.Timestamp).ToList();
        Assert.That(kept, Has.Count.EqualTo(22));
        Assert.That(kept, Does.Contain(TimeSpan.FromDays(29) + TimeSpan.FromHours(23)));
        Assert.That(kept, Does.Contain(TimeSpan.FromDays(30)), "kept for the full 30 days");
        Assert.That(kept.Max(), Is.EqualTo(TimeSpan.FromDays(30)));
    }

    [TestCase(3, 3)]
    [TestCase(25, 20)]
    public async Task Events_NewestTwentyAreKept_HoweverOld(int stored, int expected)
    {
        await using var rig = await RetentionRig.Create(settings: Tuning(pruneRows: 2));
        await rig.AddEventsAsync(Enumerable.Range(0, stored).Select(i => rig.Now - TimeSpan.FromDays(40) - TimeSpan.FromMinutes(i)).ToArray());

        await rig.Coordinator.InitializeAsync();

        var kept = (await rig.Run.EventsAsync()).Select(e => rig.Now - e.Timestamp).OrderBy(t => t).ToList();
        Assert.That(kept, Is.EqualTo(Enumerable.Range(0, expected).Select(i => TimeSpan.FromDays(40) + TimeSpan.FromMinutes(i))));
    }

    [Test]
    public async Task Events_UnresolvedOperationalState_IsNeverTouchedByRetention()
    {
        await using var rig = await RetentionRig.Create();
        var old = rig.Now - TimeSpan.FromDays(60);
        await rig.Run.EditAsync((outlets, _) =>
        {
            outlets[0].ManualHold = true;
            outlets[1].FaultHold = true;
            outlets[2].RecoveryLockout = true;
            outlets[2].RecoveryEpisodeId = Guid.NewGuid();
            outlets[2].NextRecoveryAtUtc = old;
            outlets[3].PendingCommandId = Guid.NewGuid();
            outlets[3].PendingRelayClosed = true;
            outlets[3].PendingCommandIssuedAtUtc = old;
            outlets[3].CommandNeedsReview = true;
        });
        await rig.AddEventsAsync(Enumerable.Range(0, 40).Select(i => old - TimeSpan.FromMinutes(i)).ToArray());
        var before = JsonSerializer.Serialize(await rig.Run.OutletsAsync());

        await rig.Coordinator.InitializeAsync();

        Assert.That(JsonSerializer.Serialize(await rig.Run.OutletsAsync()), Is.EqualTo(before));
        Assert.That(await rig.Run.EventsAsync(), Has.Count.EqualTo(20));
    }

    // ---- History query ------------------------------------------------------

    private static readonly TelemetryWindow[] Windows =
        [TelemetryWindow.Minutes15, TelemetryWindow.Hour1, TelemetryWindow.Hours6, TelemetryWindow.Hours24, TelemetryWindow.Days7];

    [Test]
    public async Task HistoryQuery_EveryWindowAndEnergy_UnchangedByCompaction_AndCompactedDayIsExact()
    {
        await using var rig = await RetentionRig.Create();
        await InsertMinuteSeriesAsync(rig, days: 8);
        var before = await QueryAllAsync(rig);

        await rig.Coordinator.InitializeAsync();

        var after = await QueryAllAsync(rig);
        for (var i = 0; i < Windows.Length; i++) AssertSameSeries(after[i], before[i], Windows[i]);

        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(7 * 1440 * 4));
        Assert.That(await db.TelemetryMinuteRollups.CountAsync(), Is.EqualTo(1440 * 4));
        Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(1440 * 4));
        Assert.That((await rig.FiveMinuteRollupsAsync()).Sum(r => r.SampleCount), Is.EqualTo(1440 * 4));
        var day8 = await db.TelemetryMinuteRollups.Where(r => r.OutletId == 1).ToListAsync();
        Assert.That(day8.Min(r => r.FirstEnergyKwh), Is.EqualTo(2.0).Within(1e-9));
        Assert.That(day8.Max(r => r.LastEnergyKwh), Is.EqualTo(2.0 + 1439 * 0.001).Within(1e-9));
    }

    [Test]
    public async Task HistoryQuery_LegacyCutoverAndRollback_NeverDoubleCount()
    {
        await using var rig = await RetentionRig.Create();
        await InsertMinuteSeriesAsync(rig, days: 8);
        var legacy = rig.App.Services.GetRequiredService<TelemetryRetentionService>();

        // Before cutover the legacy job compacted everything older than six hours.
        await legacy.PruneAsync(default);
        var legacyResult = await QueryAllAsync(rig);
        var legacyRollups = await rig.FiveMinuteRollupsAsync();

        await rig.Coordinator.InitializeAsync();
        var cutover = await QueryAllAsync(rig);
        for (var i = 0; i < Windows.Length; i++) AssertSameSeries(cutover[i], legacyResult[i], Windows[i]);
        Assert.That(await rig.FiveMinuteRollupsAsync(), Is.EqualTo(legacyRollups), "V2 leaves legacy five-minute rollups alone");

        // A late row older than seven days lands in a bucket the legacy job already wrote.
        var start = rig.Now - Day * 8;
        await rig.AddReadingsAsync(Reading(1, start.AddSeconds(30), 5000, 1.5));
        await rig.Coordinator.InitializeAsync();
        var merged = (await rig.FiveMinuteRollupsAsync()).Single(r => r.OutletId == 1 && r.BucketStart == start);
        var original = legacyRollups.Single(r => r.OutletId == 1 && r.BucketStart == start);
        Assert.That((merged.SampleCount, merged.PeakPowerWatts), Is.EqualTo((original.SampleCount + 1, 5000.0)));
        await using (var db = rig.Database.CreateMigrationContext())
        {
            Assert.That(await db.TelemetryMinuteRollups.SumAsync(r => r.SampleCount), Is.EqualTo(1), "minute coverage starts at cutover");
            Assert.That((await db.TelemetryCompactionCheckpoints.SingleAsync(c => c.Stream == Telemetry)).MinuteCoverageFromUtc, Is.EqualTo(start.AddSeconds(30)));
        }

        // Rollback: the legacy job resumes on the seven-day raw; the minute tier is not read.
        await InsertMinuteSeriesAsync(rig, days: 1, outletOffset: 0, energyBase: 100, from: rig.Now - TimeSpan.FromHours(20));
        var beforeRollback = await QueryAllAsync(rig);
        await legacy.PruneAsync(default);
        var rolledBack = await QueryAllAsync(rig);
        AssertSameSeries(rolledBack[4], beforeRollback[4], Windows[4], tolerance: 1e-6);
        AssertSameSeries(rolledBack[3], beforeRollback[3], Windows[3], tolerance: 1e-6);
    }

    private static async Task InsertMinuteSeriesAsync(RetentionRig rig, int days, int outletOffset = 0, double energyBase = 1.0, DateTimeOffset? from = null)
    {
        var start = from ?? rig.Now - Day * days;
        var minutes = (int)Math.Min(days * 1440, (rig.Now - start).TotalMinutes);
        await using var db = rig.Database.CreateMigrationContext();
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryReadings" ("OutletId", "Timestamp", "Voltage", "CurrentAmps", "PowerWatts", "EnergyKwh")
            SELECT o, {start} + make_interval(secs => s * 60 + o + {outletOffset}),
                   230 + (s % 7), 0.5 + (s % 5) * 0.1, 100 + (s % 13) * 10 + o, {energyBase} + s * 0.001 + o
            FROM generate_series(0, {minutes - 1}) s, generate_series(1, 4) o
            """);
    }

    private static async Task<TelemetrySeriesVm[]> QueryAllAsync(RetentionRig rig)
    {
        var results = new List<TelemetrySeriesVm>();
        foreach (var window in Windows)
        {
            // Durable-only path: no prefix cache, so every call reads the database.
            await using var db = rig.Database.CreateMigrationContext();
            results.Add(await new GetTelemetrySeriesQueryHandler(db, new DisabledHistoryBuffer(), null!, new HistoryTailMerger(), rig.Run.Clock)
                .Handle(new GetTelemetrySeriesQuery { Window = window }, default));
        }

        return results.ToArray();
    }

    private static void AssertSameSeries(TelemetrySeriesVm actual, TelemetrySeriesVm expected, TelemetryWindow window, double tolerance = 0)
    {
        Assert.Multiple(() =>
        {
            Assert.That(actual.Timestamps, Is.EqualTo(expected.Timestamps), $"{window} axis");
            Assert.That(actual.RawSampleCount, Is.EqualTo(expected.RawSampleCount), $"{window} samples");
            Assert.That(actual.LatestSampleAt, Is.EqualTo(expected.LatestSampleAt), $"{window} latest");
            Assert.That(actual.Totals.EnergyKwhDelta, Is.EqualTo(expected.Totals.EnergyKwhDelta).Within(tolerance), $"{window} energy");
            Assert.That(actual.Totals.Watts, Is.EqualTo(expected.Totals.Watts).Within(tolerance), $"{window} total watts");
            for (var c = 0; c < expected.Channels.Count; c++)
            {
                Assert.That(actual.Channels[c].SampleCount, Is.EqualTo(expected.Channels[c].SampleCount), $"{window} channel {c} samples");
                Assert.That(actual.Channels[c].Watts, Is.EqualTo(expected.Channels[c].Watts).Within(tolerance), $"{window} channel {c} watts");
                Assert.That(actual.Channels[c].PeakWatts, Is.EqualTo(expected.Channels[c].PeakWatts), $"{window} channel {c} peak");
                Assert.That(actual.Channels[c].Volts, Is.EqualTo(expected.Channels[c].Volts).Within(tolerance), $"{window} channel {c} volts");
            }
        });
    }

    private sealed class DisabledHistoryBuffer : IHistoryBuffer
    {
        public bool Enabled => false;
        public long ReserveOrdinal() => throw new NotSupportedException();
        public HistoryAcceptance Accept(AcceptedAcquisition a) => throw new NotSupportedException();
        public HistoryTailCapture CaptureTail() => throw new NotSupportedException();
        public HistoryPersistenceStatus GetStatus() => HistoryPersistenceStatus.Synchronous;
    }

    private sealed class FailCheckpointUpdate : DbCommandInterceptor
    {
        public bool Armed { get; set; }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("UPDATE \"TelemetryCompactionCheckpoints\"", StringComparison.Ordinal))
            {
                Armed = false;
                throw new IOException("Injected failure before COMMIT");
            }

            return ValueTask.FromResult(result);
        }
    }

    private sealed class LoseCommitResponse : DbTransactionInterceptor
    {
        public bool Armed { get; set; }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (Armed) { Armed = false; throw new IOException("Injected response loss after COMMIT"); }
            return Task.CompletedTask;
        }
    }
}
