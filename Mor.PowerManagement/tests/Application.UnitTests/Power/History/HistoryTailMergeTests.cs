using System.Collections.Immutable;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.UnitTests.Power.Characterization;
using Mor.PowerManagement.Infrastructure.Power.History;
using NUnit.Framework;

namespace Mor.PowerManagement.Application.UnitTests.Power.History;

public class HistoryTailMergeTests
{
    [Test]
    public void HistoryTailMerge_DurableAndTailAreWeightedBeforeRounding_AndRetainExtrema()
    {
        var at = ControlledTimeProvider.DefaultStart;
        var durable = new HistoryBucketAggregate(1, at, 400, 2, 300, 2, 4, 200, 190, 210, at);
        var acquisition = HistoryBufferTests.Sample(3, at.AddSeconds(1));
        var result = HistoryTailMerger.Merge([durable], [acquisition], 10, at, at, at.AddMinutes(1)).Single();
        Assert.That(result.SampleCount, Is.EqualTo(3));
        Assert.That(result.PowerWattsSum, Is.EqualTo(303));
        Assert.That(result.PeakWatts, Is.EqualTo(200));
        Assert.That(result.MinVolts, Is.EqualTo(190));
        Assert.That(result.MaxVolts, Is.EqualTo(238));
        Assert.That(result.LatestSampleAt, Is.EqualTo(at.AddSeconds(1)));
        Assert.That(result.EnergyKwh, Is.EqualTo(4));
    }

    [Test]
    public void HistoryTailMerge_BridgeIsBounded_AndOldPrefixMustReload()
    {
        var clock = new ControlledTimeProvider();
        var options = new HistoryPersistenceOptions { BatchPersistenceEnabled = true, BridgeMaxAcquisitions = 1 };
        var buffer = new BoundedHistoryBuffer(Options.Create(options), clock);
        buffer.Initialize(0, 0, 0, 0);
        var merger = new HistoryTailMerger();
        merger.Store(new("1h", 30, 0, clock.Peek().AddHours(-1), clock.Peek(), ImmutableArray<HistoryBucketAggregate>.Empty));
        for (var i = 1; i <= 2; i++)
        {
            buffer.Accept(HistoryBufferTests.Sample(i, clock.Peek()));
            var batch = buffer.BeginBatch()!;
            buffer.Complete(batch, new(clock.Peek(), TimeSpan.Zero, "test", "committed", 1, 2, null));
        }
        Assert.That(buffer.GetStatus().BridgeAcquisitions, Is.EqualTo(1));
        Assert.That(merger.TryGetPrefix("1h", 30, clock.Peek().AddMinutes(-30), buffer.CaptureTail()), Is.Null);
    }
}
