using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

[NonParallelizable]
public class HistoryTailTests
{
    [TestCase(TelemetryWindow.Minutes15)]
    [TestCase(TelemetryWindow.Hour1)]
    [TestCase(TelemetryWindow.Hours6)]
    [TestCase(TelemetryWindow.Hours24)]
    [TestCase(TelemetryWindow.Days7)]
    public async Task HistoryTail_LatestSampleAndWeightedBuckets_AreExactBeforeDuringAfterFlush(TelemetryWindow window)
    {
        var pause = new BulkPersistenceTests.PauseInsert();
        await using var rig = await HistoryTestRig.Create(interceptor: pause);
        await rig.Ingest(rig.Run.Sample(100));
        rig.Run.Clock.AdvanceSeconds(1);
        await rig.Ingest(rig.Run.Sample(200));
        async Task<TelemetrySeriesVm> Query()
        {
            using var scope = rig.App.Services.CreateScope();
            return await scope.ServiceProvider.GetRequiredService<ISender>().Send(new GetTelemetrySeriesQuery { Window = window });
        }
        var before = await Query();
        Assert.That(before.RawSampleCount, Is.EqualTo(10));
        Assert.That(before.Channels[0].Watts.Last(v => v.HasValue), Is.EqualTo(150));
        Assert.That(before.Channels[0].PeakWatts.Last(v => v.HasValue), Is.EqualTo(200));
        Assert.That(before.Channels[0].Watts.Count(v => !v.HasValue), Is.EqualTo(before.BucketCount - 1));
        pause.Armed = true;
        var flush = rig.Coordinator.FlushAsync("chart-race");
        await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        TelemetrySeriesVm during;
        try
        {
            rig.Run.Clock.AdvanceSeconds(1);
            await rig.Ingest(rig.Run.Sample(300));
            during = await Query();
            Assert.That(during.RawSampleCount, Is.EqualTo(15));
            Assert.That(during.LatestSampleAt, Is.EqualTo(rig.Run.Clock.Peek()));
            Assert.That(during.Channels[0].Watts.Last(v => v.HasValue), Is.EqualTo(200));
            Assert.That(during.Channels[0].PeakWatts.Last(v => v.HasValue), Is.EqualTo(300));
        }
        finally { pause.Release.TrySetResult(); }
        Assert.That(await flush, Is.True);
        var after = await Query();
        Assert.That(after.RawSampleCount, Is.EqualTo(during.RawSampleCount));
        Assert.That(after.Channels[0].Watts, Is.EqualTo(during.Channels[0].Watts));
        Assert.That(after.LatestSampleAt, Is.EqualTo(during.LatestSampleAt));
        Assert.That(after.Totals.EnergyKwhDelta, Is.EqualTo(during.Totals.EnergyKwhDelta));
        Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
        var allDurable = await Query();
        Assert.That(allDurable.RawSampleCount, Is.EqualTo(15));
        // Compare against the unchanged durable-only query at the same clock.
        await using var db = rig.Database.CreateMigrationContext();
        var baseline = await new GetTelemetrySeriesQueryHandler(db,
            new DisabledHistoryBuffer(), rig.Store, new(), rig.Run.Clock).Handle(new() { Window = window }, default);
        Assert.That(allDurable.Channels.Select(c => c.SampleCount), Is.EqualTo(baseline.Channels.Select(c => c.SampleCount)));
        Assert.That(allDurable.Channels[0].Watts, Is.EqualTo(baseline.Channels[0].Watts));
        Assert.That(allDurable.Totals.EnergyKwhDelta, Is.EqualTo(baseline.Totals.EnergyKwhDelta));
    }

    private sealed class DisabledHistoryBuffer : Mor.PowerManagement.Application.Power.History.IHistoryBuffer
    {
        public bool Enabled => false;
        public long ReserveOrdinal() => throw new NotSupportedException();
        public Mor.PowerManagement.Application.Power.History.HistoryAcceptance Accept(Mor.PowerManagement.Application.Power.History.AcceptedAcquisition a) => throw new NotSupportedException();
        public Mor.PowerManagement.Application.Power.History.HistoryTailCapture CaptureTail() => throw new NotSupportedException();
        public Mor.PowerManagement.Application.Power.History.HistoryPersistenceStatus GetStatus() => Mor.PowerManagement.Application.Power.History.HistoryPersistenceStatus.Synchronous;
    }
}
