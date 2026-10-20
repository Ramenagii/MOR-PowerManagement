using Microsoft.Extensions.Options;
using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Power.History;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

[NonParallelizable]
public class BulkPersistenceTests
{
    [Test]
    public async Task BulkPersistence_900Acquisitions_KeepEveryBranchMirrorAndIna_AndDrainOnce()
    {
        await using var rig = await HistoryTestRig.Create();
        for (var i = 0; i < 900; i++)
        {
            var sample = rig.Run.Sample();
            await rig.Ingest(sample with
            {
                Readings = sample.Readings.Take(4).ToList(),
                Ina = new() { BusV = 24, CurrentA = 0.1, PowerW = 2.4 },
            });
            rig.Run.Clock.AdvanceSeconds(1);
        }
        Assert.That(rig.Buffer.GetStatus().BufferedRows, Is.EqualTo(5400));
        Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(4500));
        Assert.That(await db.InaReadings.CountAsync(), Is.EqualTo(900));
        Assert.That(await db.TelemetryReadings.CountAsync(r => r.OutletId == 5), Is.EqualTo(900));
        Assert.That((await db.TelemetryPersistenceCheckpoints.SingleAsync(c => c.Stream == "history")).CommittedRows, Is.EqualTo(5400));
        var before = rig.Metrics.Snapshot().TotalCommandAttempts;
        Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
        Assert.That(rig.Metrics.Snapshot().TotalCommandAttempts, Is.EqualTo(before), "empty drain cannot wake DB");
    }

    [Test]
    public async Task BulkPersistence_UncertainCommit_RetriesSameIdentityWithoutDuplicates()
    {
        var fault = new LoseCommitResponse();
        await using var rig = await HistoryTestRig.Create(interceptor: fault);
        await rig.Ingest(rig.Run.Sample());
        var batch = rig.Buffer.BeginBatch()!;
        fault.Armed = true;
        Assert.That(await rig.Coordinator.FlushAsync("uncertain"), Is.False);
        Assert.That(rig.Buffer.CaptureTail().CommittedWatermark, Is.Zero);
        Assert.That(rig.Buffer.BeginBatch(), Is.SameAs(batch));
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(5), "commit actually succeeded");
        Assert.That(await rig.Coordinator.FlushAsync("retry"), Is.True);
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(5));
        Assert.That(rig.Buffer.CaptureTail().CommittedWatermark, Is.EqualTo(batch.Acquisitions[^1].Ordinal));
    }

    [Test]
    public async Task BulkPersistence_SlowWriter_DoesNotBlockEvaluation_OrOverwriteNewerControlCheckpoint()
    {
        var pause = new PauseInsert();
        await using var rig = await HistoryTestRig.Create(interceptor: pause);
        await rig.Ingest(rig.Run.Sample());
        pause.Armed = true;
        var flush = rig.Coordinator.FlushAsync("slow");
        await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            rig.Run.Clock.AdvanceSeconds(1);
            var ingest = rig.Ingest(rig.Run.Sample(200));
            Assert.That((await ingest.WaitAsync(TimeSpan.FromSeconds(5))).TotalWatts, Is.EqualTo(200));
            Assert.That(rig.Buffer.GetStatus().InFlightAcquisitions, Is.EqualTo(1));
            Assert.That(rig.Buffer.GetStatus().ActiveAcquisitions, Is.EqualTo(1));
        }
        finally { pause.Release.TrySetResult(); }
        Assert.That(await flush, Is.True);
        await rig.Ingest(rig.Run.Sample(1400));
        rig.Run.Clock.AdvanceSeconds(3);
        await rig.Ingest(rig.Run.Sample(1400));
        await using var db = rig.Database.CreateMigrationContext();
        var newer = await db.PowerSystemConfigs.AsNoTracking().SingleAsync();
        // Flush a batch ending before the transition: checkpoint condition must preserve the transition identity.
        rig.App.Services.GetRequiredService<IOptions<HistoryPersistenceOptions>>().Value.MaxAcquisitionsPerBatch = 1;
        var oldBatch = rig.Buffer.BeginBatch()!;
        Assert.That(oldBatch.Acquisitions[^1].Live.LastAcquisitionSequence, Is.LessThan(newer.LastAcquisitionSequence));
        Assert.That(await rig.Coordinator.FlushAsync("older-history"), Is.True);
        Assert.That((await db.PowerSystemConfigs.AsNoTracking().SingleAsync()).LastAcquisitionSequence, Is.EqualTo(newer.LastAcquisitionSequence));
    }

    [Test]
    public async Task BulkPersistence_InactivityAndShutdown_FlushPartialBatches()
    {
        await using var rig = await HistoryTestRig.Create();
        await rig.Ingest(rig.Run.Sample());
        rig.Run.Clock.AdvanceSeconds(29);
        Assert.That(rig.Buffer.IsDue(), Is.False);
        rig.Run.Clock.AdvanceSeconds(1);
        Assert.That(rig.Buffer.IsDue(), Is.True);
        Assert.That(await rig.Coordinator.FlushAsync("inactivity"), Is.True);
        await rig.Ingest(rig.Run.Sample());
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await rig.Coordinator.StopAsync(cancelled.Token);
        Assert.That(rig.Buffer.GetStatus().ShutdownFlush!.Outcome, Is.EqualTo("committed"));
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(10));
    }

    [Test]
    public async Task BulkPersistence_OverflowKeepsEvaluationResponsive_AndGapSurvivesRestart()
    {
        await using var rig = await HistoryTestRig.Create();
        rig.App.Services.GetRequiredService<IOptions<HistoryPersistenceOptions>>().Value.MaxBufferedAcquisitions = 2;
        await rig.Ingest(rig.Run.Sample());
        await rig.Ingest(rig.Run.Sample());
        var dropped = await rig.Ingest(rig.Run.Sample(200));
        Assert.That(dropped.HistoryPersistence, Is.EqualTo("dropped"));
        Assert.That((await rig.Store.GetAsync()).Outlets[0].CurrentWatts, Is.EqualTo(200));
        Assert.That(rig.Buffer.GetStatus().TotalDroppedRows, Is.EqualTo(5));
        Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
        await using var db = rig.Database.CreateMigrationContext();
        var checkpoint = await db.TelemetryPersistenceCheckpoints.SingleAsync(c => c.Stream == "history");
        Assert.That(checkpoint.DroppedAcquisitions, Is.EqualTo(1));
        Assert.That(checkpoint.DroppedRows, Is.EqualTo(5));
        using var restart = HistoryTestRig.BuildHost(rig.Database, rig.Run, true, true);
        var restored = restart.Services.GetRequiredService<BoundedHistoryBuffer>();
        await restart.Services.GetRequiredService<TelemetryBulkWriter>().InitializeAsync(restored, default);
        Assert.That(restored.GetStatus().Gaps.Single().Recorded, Is.True);
        Assert.That(restored.GetStatus().AcceptanceFailing, Is.True);
    }

    [Test]
    public async Task BulkPersistence_FailedDrainStopsRollback_AndShutdownReportsFailure()
    {
        var fault = new LoseCommitResponse();
        await using var rig = await HistoryTestRig.Create(interceptor: fault);
        await rig.Ingest(rig.Run.Sample());
        fault.Armed = true;
        Assert.That(await rig.Coordinator.DrainAsync(), Is.False);
        Assert.That(rig.Buffer.GetStatus().InFlightAcquisitions, Is.EqualTo(1));
        // Resolve the uncertain commit using the same identity before switching writers.
        Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
        await rig.Ingest(rig.Run.Sample());
        fault.Armed = true;
        await rig.Coordinator.StopAsync(default);
        Assert.That(rig.Buffer.GetStatus().ShutdownFlush!.Outcome, Is.EqualTo("failed"));
        Assert.That(rig.Buffer.GetStatus().InFlightAcquisitions, Is.EqualTo(1));
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

    internal sealed class PauseInsert : DbCommandInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("INSERT INTO \"TelemetryReadings\"", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }
}
