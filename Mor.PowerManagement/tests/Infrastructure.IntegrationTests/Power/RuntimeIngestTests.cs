using Mor.PowerManagement.Application.Power.Commands.AcknowledgeOutletFault;
using Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;
using Mor.PowerManagement.Application.Power.Commands.ClearOutletRecoveryState;
using Mor.PowerManagement.Application.Power.Commands.RunStagedRestoration;
using Mor.PowerManagement.Application.Power.Commands.SetManualOverride;
using Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;
using Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;
using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;
using Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Mor.PowerManagement.Infrastructure.Observability;
using Mor.PowerManagement.Infrastructure.Power;
using Mor.PowerManagement.Infrastructure.Power.History;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

[NonParallelizable]
public class RuntimeIngestTests
{
    [Test]
    public async Task RuntimeIngest_SteadySamplesAndDuplicates_ExecuteZeroCommands()
    {
        await using var rig = await HistoryTestRig.Create();
        var before = rig.Metrics.Snapshot().TotalCommandAttempts;
        IngestTelemetryResult? result = null;
        for (var i = 0; i < 100; i++)
        {
            result = await rig.Ingest(rig.Run.Sample());
            rig.Run.Clock.AdvanceSeconds(1);
        }
        var duplicate = await rig.Ingest(rig.Run.Sample() with { AcquisitionSequence = 1 });
        Assert.That(rig.Metrics.Snapshot().TotalCommandAttempts - before, Is.Zero);
        Assert.That(duplicate.ReadingsStored, Is.Zero);
        Assert.That(result!.HistoryPersistence, Is.EqualTo("buffered"));
        Assert.That(rig.Buffer.GetStatus().TotalAcceptedAcquisitions, Is.EqualTo(100));
        Assert.That((await rig.Store.GetAsync()).EffectiveConfig.LastAcquisitionSequence, Is.EqualTo(100));
    }

    [Test]
    public async Task RuntimeIngest_ImmediateShedAndAck_AreDurableBeforeResponse_AndRestartDeduplicates()
    {
        await using var rig = await HistoryTestRig.Create();
        await rig.Ingest(rig.Run.Sample(1400));
        rig.Run.Clock.AdvanceSeconds(3);
        var result = await rig.Ingest(rig.Run.Sample(1400));
        Assert.That(result.Shedding!.Action, Is.EqualTo("Shed"));
        await using var db = rig.Database.CreateMigrationContext();
        var outlet = await db.Outlets.AsNoTracking().SingleAsync(o => o.Id == 1);
        Assert.That(outlet.PendingCommandId, Is.Not.Null);
        Assert.That(await db.PowerEvents.CountAsync(), Is.GreaterThan(0));
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.Zero, "history still waits for flush");
        var ack = rig.Run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = outlet.PendingCommandId }] };
        await rig.Ingest(ack);
        Assert.That((await db.Outlets.AsNoTracking().SingleAsync(o => o.Id == 1)).PendingCommandAcknowledgedAtUtc, Is.Not.Null);
        using var restarted = HistoryTestRig.BuildHost(rig.Database, rig.Run, true, true);
        await restarted.HydratePowerRuntimeAsync();
        await restarted.Services.GetRequiredService<TelemetryBulkWriter>().InitializeAsync(
            restarted.Services.GetRequiredService<BoundedHistoryBuffer>(), default);
        Assert.That(restarted.Services.GetRequiredService<BoundedHistoryBuffer>().GetStatus().ActiveAcquisitions, Is.Zero,
            "restart loses unflushed memory; no history is replayed into control");
        using var scope = restarted.Services.CreateScope();
        var repeated = await scope.ServiceProvider.GetRequiredService<ISender>().Send(ack);
        Assert.That(repeated.ReadingsStored, Is.Zero);
        var recovered = await restarted.Services.GetRequiredService<IPowerRuntimeStore>().GetAsync();
        Assert.That(recovered.Outlets[0].PendingCommandId, Is.EqualTo(outlet.PendingCommandId));
        rig.Run.Clock.AdvanceSeconds(31);
        Assert.That(recovered.Outlets.All(o => o.LastSeen < rig.Run.Clock.Peek().AddSeconds(-30)), Is.True);
    }

    [Test]
    public async Task RuntimeIngest_AdminActivation_UsesUnflushedWatts()
    {
        await using var rig = await HistoryTestRig.Create();
        await rig.Run.EditAsync((outlets, _) => outlets[1].AllowanceWatts = 500);
        // This test starts a fresh snapshot after the setup edit.
        using var app = HistoryTestRig.BuildHost(rig.Database, rig.Run, true, true);
        await app.HydratePowerRuntimeAsync();
        await app.Services.GetRequiredService<TelemetryBulkWriter>().InitializeAsync(app.Services.GetRequiredService<BoundedHistoryBuffer>(), default);
        using (var scope = app.Services.CreateScope()) await scope.ServiceProvider.GetRequiredService<ISender>().Send(rig.Run.Sample(900));
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IApplicationDbContext>();
            var result = await new RequestOutletActivationCommandHandler(db, rig.Run.Clock,
                app.Services.GetRequiredService<PowerMutationCoordinator>()).Handle(new() { OutletId = 2 }, default);
            Assert.That(result.Allowed, Is.False, "900 live W + 500 W exceeds 1300 W; durable watts are still zero");
        }
    }

    [Test]
    public async Task RuntimeIngest_FailedControlCommit_PublishesNothingAndCannotReturnSuccess()
    {
        var failure = new FailControlInsert();
        await using var rig = await HistoryTestRig.Create(interceptor: failure);
        var before = await rig.Store.GetAsync();
        failure.Armed = true;
        Assert.ThrowsAsync<DbUpdateException>(() => rig.Ingest(rig.Run.Sample(1400)));
        Assert.That(await rig.Store.GetAsync(), Is.SameAs(before));
        Assert.That(rig.Buffer.GetStatus().TotalAcceptedAcquisitions, Is.Zero);
        await using var db = rig.Database.CreateMigrationContext();
        Assert.That(await db.PowerEvents.CountAsync(), Is.Zero);
        Assert.That((await db.PowerSystemConfigs.SingleAsync()).LastAcquisitionSessionId, Is.Null);
    }

    private sealed class FailControlInsert : DbCommandInterceptor
    {
        public bool Armed { get; set; }
        public override ValueTask<InterceptionResult<System.Data.Common.DbDataReader>> ReaderExecutingAsync(System.Data.Common.DbCommand command,
            CommandEventData eventData, InterceptionResult<System.Data.Common.DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("INSERT INTO \"PowerEvents\"", StringComparison.Ordinal))
                throw new InvalidOperationException("Injected control persistence failure");
            return ValueTask.FromResult(result);
        }
    }

    [Test]
    public async Task RuntimeIngest_ControlTrace_EqualsLegacy_AndSynchronousRuntime()
    {
        var traces = new List<List<string>>();
        foreach (var mode in new[] { (false, false), (true, false), (true, true) })
        {
            await using var rig = await HistoryTestRig.Create(mode.Item1, mode.Item2);
            var trace = new List<string>();
            async Task Record(string label, object result, object? command = null)
            {
                // Align only history durability for the comparison; each decision precedes the flush.
                if (mode.Item2) Assert.That(await rig.Coordinator.DrainAsync(), Is.True);
                var text = await rig.Run.TraceAsync(label, result, command);
                var node = JsonNode.Parse(text)!;
                foreach (var field in new[] { "Created", "LastModified", "CreatedBy", "LastModifiedBy" }) node["config"]!.AsObject().Remove(field);
                text = node.ToJsonString();
                trace.Add(text);
            }
            async Task Step(IngestTelemetryCommand command)
            {
                var result = await rig.Ingest(command);
                await Record("ingest", result with { HistoryPersistence = null }, command);
            }
            async Task Action<T>(string label, Func<IApplicationDbContext, PowerMutationCoordinator, Task<T>> action)
            {
                using var scope = rig.App.Services.CreateScope();
                var result = await action(scope.ServiceProvider.GetRequiredService<IApplicationDbContext>(), rig.App.Services.GetRequiredService<PowerMutationCoordinator>());
                await Record(label, result!);
            }
            await Step(rig.Run.Sample(1400));
            rig.Run.Clock.AdvanceSeconds(3);
            await Step(rig.Run.Sample(1400));
            var commandId = (await rig.Run.OutletsAsync())[0].PendingCommandId;
            await Step(rig.Run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = Guid.Parse("44444444-4444-4444-4444-444444444444") }] });
            await Step(rig.Run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = commandId }] });
            rig.Run.Clock.Advance(TimeSpan.FromMilliseconds(501));
            await Step(rig.Run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = false, CommandId = commandId }] });
            await Step(rig.Run.Sample() with { AcquisitionSequence = 1 });
            rig.Run.Clock.AdvanceSeconds(56);
            await Step(rig.Run.Sample());
            var trialId = (await rig.Run.OutletsAsync())[0].PendingCommandId;
            await Step(rig.Run.Sample() with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = trialId }] });
            rig.Run.Clock.Advance(TimeSpan.FromMilliseconds(501));
            for (var i = 0; i < 3; i++)
            {
                await Step(rig.Run.Sample(1400) with { RelayStates = [new() { OutletId = 1, RelayClosed = true, CommandId = trialId }] });
                rig.Run.Clock.AdvanceSeconds(1);
            }
            rig.Run.Clock.AdvanceSeconds(6);
            await Step(rig.Run.Sample());
            await Step(rig.Run.Sample());
            await Action("clear-recovery", (db, m) => new ClearOutletRecoveryStateCommandHandler(db, rig.Run.Clock, m).Handle(new(1), default));
            await Action("manual-off", (db, m) => new DisconnectOutletCommandHandler(db, rig.Run.Clock, m).Handle(new() { OutletId = 2 }, default));
            await Action("manual-off", (db, m) => new DisconnectOutletCommandHandler(db, rig.Run.Clock, m).Handle(new() { OutletId = 2 }, default));
            await Action("manual-on", (db, m) => new RequestOutletActivationCommandHandler(db, rig.Run.Clock, m).Handle(new() { OutletId = 2 }, default));
            IngestTelemetryCommand Load()
            {
                var sample = rig.Run.Sample();
                return sample with { Readings = sample.Readings.Select(r => r with { PowerWatts = r.OutletId == 3 ? 1100 : 0, CurrentAmps = r.OutletId == 3 ? 1100.0 / 238 : 0 }).ToList() };
            }
            rig.Run.Clock.AdvanceSeconds(1);
            await Step(Load());
            await Action("override", (db, m) => new SetManualOverrideCommandHandler(db, rig.Run.Framework, rig.Run.Clock, m).Handle(new() { Enabled = true, Reason = "bench test" }, default));
            await Step(Load());
            await Step(Load());
            await Action("selective", (db, m) => new ApplySelectiveResponseCommandHandler(db, rig.Run.Framework, rig.Run.Clock, m).Handle(new() { Count = 3, ManualOverride = true }, default));
            rig.Run.Clock.AdvanceSeconds(1);
            await Action("restore", (db, m) => new RunStagedRestorationCommandHandler(db, rig.Run.Framework, rig.Run.Clock, m).Handle(new() { Force = true }, default));
            await Action("override", (db, m) => new SetManualOverrideCommandHandler(db, rig.Run.Framework, rig.Run.Clock, m).Handle(new() { Enabled = false }, default));
            await Action("policy", (db, m) => new UpdateOutletPolicyCommandHandler(db, rig.Run.Clock, m).Handle(new() { OutletId = 3, Name = "Scope bench", Priority = Mor.PowerManagement.Domain.Enums.OutletPriority.Critical, AllowanceWatts = 450, IsProtected = true, IdleLimitMinutes = 15 }, default));
            await Action("thresholds", (db, m) => new UpdateThresholdsCommandHandler(db, rig.Run.Clock, m).Handle(new() { WarningThresholdWatts = 1000, CriticalThresholdWatts = 1250, StandbyIdleMinutes = 20 }, default));
            rig.Run.Clock.AdvanceSeconds(1);
            await Step(rig.Run.Sample() with { FaultFlag = true });
            await Action("ack-fault", (db, m) => new AcknowledgeOutletFaultCommandHandler(db, rig.Run.Clock, m).Handle(new(4), default));
            await Action("manual-on", (db, m) => new RequestOutletActivationCommandHandler(db, rig.Run.Clock, m).Handle(new() { OutletId = 1 }, default));
            traces.Add(trace);
            var directory = Path.Combine(TestContext.CurrentContext.WorkDirectory, "control-traces");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, $"RuntimeIngest_{mode.Item1}_{mode.Item2}.jsonl");
            await File.WriteAllLinesAsync(path, trace);
            TestContext.AddTestAttachment(path);
        }
        for (var mode = 1; mode < traces.Count; mode++)
        {
            for (var i = 0; i < traces[0].Count; i++)
                Assert.That(JsonNode.DeepEquals(JsonNode.Parse(traces[mode][i]), JsonNode.Parse(traces[0][i])), Is.True,
                    $"Mode {mode}, step {i}: control trace differs (object property order is immaterial).");
        }
    }
}

internal sealed class HistoryTestRig : IAsyncDisposable
{
    public required PostgresFixture Database { get; init; }
    public required ControlScenarioRunner Run { get; init; }
    public required IHost App { get; init; }
    public BoundedHistoryBuffer Buffer => App.Services.GetRequiredService<BoundedHistoryBuffer>();
    public BatchWindowCoordinator Coordinator => App.Services.GetRequiredService<BatchWindowCoordinator>();
    public IPowerRuntimeStore Store => App.Services.GetRequiredService<IPowerRuntimeStore>();
    public TelemetryDatabaseMetrics Metrics => App.Services.GetRequiredService<TelemetryDatabaseMetrics>();

    public static async Task<HistoryTestRig> Create(bool runtime = true, bool batched = true, IInterceptor? interceptor = null)
    {
        var db = await PostgresFixture.CreateAsync();
        var run = new ControlScenarioRunner(db);
        await run.SeedAsync();
        var host = BuildHost(db, run, runtime, batched, interceptor);
        var rig = new HistoryTestRig { Database = db, Run = run, App = host };
        await host.HydratePowerRuntimeAsync();
        if (batched) await host.Services.GetRequiredService<TelemetryBulkWriter>().InitializeAsync(rig.Buffer, default);
        return rig;
    }

    public static IHost BuildHost(PostgresFixture db, ControlScenarioRunner run, bool runtime, bool batched, IInterceptor? interceptor = null)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { DisableDefaults = true, EnvironmentName = "Development" });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Mor.PowerManagementDb"] = db.ConnectionString,
            ["Telemetry:CachedReadsEnabled"] = runtime.ToString(),
            ["Telemetry:RuntimeIngestEnabled"] = runtime.ToString(),
            ["Telemetry:BatchPersistenceEnabled"] = batched.ToString(),
            ["Telemetry:Measurement:Enabled"] = "true",
        });
        builder.Services.AddLogging();
        builder.AddApplicationServices();
        builder.AddInfrastructureServices();
        if (interceptor is not null) builder.Services.AddDbContext<ApplicationDbContext>((_, o) => o.AddInterceptors(interceptor));
        builder.Services.AddSingleton<TimeProvider>(run.Clock);
        builder.Services.AddSingleton(run.Framework);
        builder.Services.AddScoped<IUser, TestUser>();
        builder.Services.AddScoped<ICurrentUserName>(_ => new ClaimsCurrentUserName(() => null));
        return builder.Build();
    }

    public async Task<IngestTelemetryResult> Ingest(IngestTelemetryCommand command)
    {
        using var scope = App.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<ISender>().Send(command);
    }

    public async ValueTask DisposeAsync()
    {
        App.Dispose();
        await Database.DisposeAsync();
    }

    private sealed class TestUser : IUser
    {
        public string? Id => null;
        public List<string>? Roles => null;
    }
}
