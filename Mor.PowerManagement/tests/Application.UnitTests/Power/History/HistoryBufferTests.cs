using System.Collections.Immutable;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.UnitTests.Power.Characterization;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Infrastructure.Power.History;
using NUnit.Framework;

namespace Mor.PowerManagement.Application.UnitTests.Power.History;

public class HistoryBufferTests
{
    internal static AcceptedAcquisition Sample(long ordinal, DateTimeOffset timestamp, int samples = 1) => new(ordinal, timestamp,
        Enumerable.Range(1, samples).Select(id => new HistorySample(id, 238, 1, ordinal, ordinal)).ToImmutableArray(),
        new(24, null, 0.1, 2.4), new(1, Guid.Empty, ordinal, MeteringMode.Unknown, null, ImmutableArray<OutletLiveState>.Empty));

    [TestCase("acquisitions")]
    [TestCase("rows")]
    [TestCase("bytes")]
    public void HistoryBuffer_ActiveAndInFlightShareBounds_OverflowIsVisible(string bound)
    {
        var clock = new ControlledTimeProvider();
        var first = Sample(1, clock.Peek());
        var options = new HistoryPersistenceOptions { BatchPersistenceEnabled = true,
            MaxBufferedAcquisitions = bound == "acquisitions" ? 2 : 100,
            MaxBufferedRows = bound == "rows" ? 4 : 100,
            MaxBufferedBytes = bound == "bytes" ? first.AccountedBytes * 2 : 100_000 };
        var buffer = new BoundedHistoryBuffer(Options.Create(options), clock);
        buffer.Initialize(0, 0, 0, 0);
        buffer.Accept(first);
        var flight = buffer.BeginBatch()!;
        buffer.Accept(Sample(2, clock.Peek()));
        for (var i = 3; i < 10_003; i++) Assert.That(buffer.Accept(Sample(i, clock.Peek())), Is.EqualTo(HistoryAcceptance.Dropped));
        var status = buffer.GetStatus();
        Assert.That(status.ActiveAcquisitions + status.InFlightAcquisitions, Is.EqualTo(2));
        Assert.That(status.AccountedBytes, Is.EqualTo(first.AccountedBytes * 2));
        Assert.That(status.BufferedRows, Is.EqualTo(4));
        Assert.That(status.TotalDroppedAcquisitions, Is.EqualTo(10_000));
        Assert.That(status.TotalDroppedRows, Is.EqualTo(20_000));
        Assert.That(status.Gaps, Has.Count.EqualTo(1));
        Assert.That(status.AcceptanceFailing, Is.True);
        Assert.That(buffer.BeginBatch(), Is.SameAs(flight));
    }

    [Test]
    public void HistoryBuffer_InFlightAgeIsMeasured_AndBreachSurvivesCommit()
    {
        var clock = new ControlledTimeProvider();
        var buffer = new BoundedHistoryBuffer(Options.Create(new HistoryPersistenceOptions { BatchPersistenceEnabled = true }), clock);
        buffer.Initialize(0, 0, 0, 0);
        buffer.Accept(Sample(1, clock.Peek()));
        var batch = buffer.BeginBatch()!;
        clock.AdvanceSeconds(901);
        Assert.That(buffer.GetStatus().LossGuaranteeBreached, Is.True);
        buffer.Complete(batch, new(clock.Peek(), TimeSpan.Zero, "test", "committed", 1, 2, null));
        Assert.That(buffer.GetStatus().LossGuaranteeBreached, Is.True);
        Assert.That(buffer.GetStatus().BufferedRows, Is.Zero);
    }

    [TestCase(false, false, false, true)]
    [TestCase(true, false, false, true)]
    [TestCase(true, true, false, true)]
    [TestCase(true, true, true, true)]
    [TestCase(false, true, false, false)]
    [TestCase(false, false, true, false)]
    [TestCase(false, true, true, false)]
    [TestCase(true, false, true, false)]
    public void HistoryBuffer_FlagCombinations_SelectExactlyOneWriter(bool cached, bool runtime, bool batch, bool valid)
    {
        var options = new HistoryPersistenceOptions { RuntimeIngestEnabled = runtime, BatchPersistenceEnabled = batch };
        if (valid) Assert.DoesNotThrow(() => options.Validate(new() { CachedReadsEnabled = cached }));
        else Assert.Throws<InvalidOperationException>(() => options.Validate(new() { CachedReadsEnabled = cached }));
    }

    [Test]
    public void HistoryBuffer_RuntimeRequestBounds_PreserveRepeatedSamples_ButRejectOversizedLists()
    {
        var validator = new IngestTelemetryCommandValidator(Options.Create(new HistoryPersistenceOptions { RuntimeIngestEnabled = true }));
        var command = new IngestTelemetryCommand { Readings = Enumerable.Repeat(new TelemetrySample { OutletId = 1 }, 13).ToList() };
        Assert.That(validator.Validate(command).IsValid, Is.True);
        Assert.That(validator.Validate(command with { Readings = Enumerable.Repeat(new TelemetrySample { OutletId = 1 }, 14).ToList() }).IsValid, Is.False);
        Assert.That(new HistoryPersistenceOptions().RuntimeIngestEnabled, Is.False);
        Assert.That(new HistoryPersistenceOptions().BatchPersistenceEnabled, Is.False);
    }
}
