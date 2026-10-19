using System.Collections.Immutable;
using System.Security.Claims;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Queries.GetDashboardState;
using Mor.PowerManagement.Application.Power.Queries.GetDeviceConfig;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Application.UnitTests.Power.Characterization;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;
using Mor.PowerManagement.Infrastructure.Power;
using NUnit.Framework;

namespace Mor.PowerManagement.Application.UnitTests.Power.Runtime;

/// <summary>
/// PLAN-0001 Spec D: runtime snapshot, single-flight hydration, serialized
/// post-commit publication, freshness, the voltage window, the single-writer
/// guard and the W-12 claims-only user name. No database: the hydrator is a
/// fake and every clock is controlled.
/// </summary>
public class PowerRuntimeTests
{
    private static readonly DateTimeOffset T0 = ControlledTimeProvider.DefaultStart;

    // ---- Hydration ------------------------------------------------------

    [Test]
    public async Task Hydration_ConcurrentFirstReaders_RunExactlyOneHydration()
    {
        var hydrator = new FakeHydrator { Gate = new TaskCompletionSource() };
        var store = new PowerRuntimeStore(true, new LoadSheddingStateStore(), hydrator);

        var readers = Enumerable.Range(0, 64).Select(_ => Task.Run(() => store.GetAsync())).ToList();
        await Task.Delay(50); // let every reader join before the hydration completes
        Assert.That(store.Published, Is.Null, "nothing is published before hydration completes");
        hydrator.Gate.SetResult();
        var snapshots = await Task.WhenAll(readers);

        Assert.That(hydrator.Calls, Is.EqualTo(1));
        Assert.That(store.HydrationCount, Is.EqualTo(1));
        Assert.That(snapshots.Distinct().Count(), Is.EqualTo(1), "every reader receives the same published snapshot");
        Assert.That(snapshots[0].LiveVersion, Is.EqualTo(1));
    }

    [Test]
    public async Task Hydration_ConcurrentWithMutation_StillRunsOnce()
    {
        var hydrator = new FakeHydrator { Gate = new TaskCompletionSource() };
        var framework = new LoadSheddingStateStore();
        var store = new PowerRuntimeStore(true, framework, hydrator);
        var coordinator = new PowerMutationCoordinator(framework, store, new ControlledTimeProvider());

        var mutation = coordinator.ExecuteAsync(m => Task.FromResult(m.Captured), CancellationToken.None);
        var readers = Enumerable.Range(0, 16).Select(_ => Task.Run(() => store.GetAsync())).ToList();
        hydrator.Gate.SetResult();
        var captured = await mutation;
        await Task.WhenAll(readers);

        Assert.That(hydrator.Calls, Is.EqualTo(1));
        Assert.That(captured, Is.SameAs(store.Published));
    }

    [Test]
    public async Task Hydration_Failure_PublishesNothing_AndRetriesOnlyOnDemand()
    {
        var hydrator = new FakeHydrator { Failures = 2 };
        var store = new PowerRuntimeStore(true, new LoadSheddingStateStore(), hydrator);

        var first = Assert.ThrowsAsync<PowerRuntimeUnavailableException>(() => store.GetAsync());
        Assert.That(first!.InnerException, Is.InstanceOf<InvalidOperationException>());
        Assert.That(store.Published, Is.Null, "a failed hydration must not leave default state published");
        Assert.That(hydrator.Calls, Is.EqualTo(1), "no background retry");

        // The device config read surfaces the failure instead of inventing defaults.
        var handler = new GetDeviceConfigQueryHandler(Mock.Of<IApplicationDbContext>(MockBehavior.Strict), store);
        Assert.ThrowsAsync<PowerRuntimeUnavailableException>(() => handler.Handle(new GetDeviceConfigQuery(), CancellationToken.None));
        Assert.That(hydrator.Calls, Is.EqualTo(2), "the next request tries again, on demand");

        var snapshot = await store.GetAsync();
        Assert.That(hydrator.Calls, Is.EqualTo(3));
        Assert.That(snapshot.Outlets, Has.Length.EqualTo(5));
    }

    [Test]
    public void Disabled_StoreRefusesReads_AndCoordinatorAppliesFrameworkImmediately()
    {
        var hydrator = new FakeHydrator();
        var framework = new LoadSheddingStateStore();
        var store = new PowerRuntimeStore(false, framework, hydrator);
        var coordinator = new PowerMutationCoordinator(framework, store, new ControlledTimeProvider());

        Assert.ThrowsAsync<PowerRuntimeUnavailableException>(() => store.GetAsync());
        Assert.That(coordinator.Serialized, Is.False);

        // Legacy semantics: a framework write is visible immediately, before
        // (and regardless of) any commit, exactly as the handlers behaved before.
        Assert.ThrowsAsync<InvalidOperationException>(() => coordinator.ExecuteAsync<int>(m =>
        {
            Assert.That(m.IsLegacy, Is.True);
            m.UpdateFramework(s => s with { ManualOverride = true });
            Assert.That(framework.Current.ManualOverride, Is.True);
            throw new InvalidOperationException("commit failed");
        }, CancellationToken.None));
        Assert.That(framework.Current.ManualOverride, Is.True);
        Assert.That(hydrator.Calls, Is.Zero);
    }

    // ---- Publication ------------------------------------------------------

    [Test]
    public async Task FailedCommit_PublishesNoConfigEventCommandOrFramework()
    {
        var (store, framework, coordinator, _) = await HydratedAsync();
        var before = store.Published!;
        var frameworkBefore = framework.Current;

        Assert.ThrowsAsync<InvalidOperationException>(() => coordinator.ExecuteAsync<int>(m =>
        {
            var config = Config();
            config.CriticalThresholdWatts = 900;
            var outlet = Entity(1);
            outlet.Status = OutletStatus.Disconnected;
            outlet.PendingCommandId = Guid.NewGuid();
            m.StageConfig(config);
            m.StageOutlet(outlet);
            m.StageEvent(new PowerEvent { Id = 99, Timestamp = T0, Title = "Should not appear" });
            m.UpdateFramework(s => s with { ManualOverride = true, ConsecutiveOverLimitBatches = 7 });
            Assert.That(m.Framework.ManualOverride, Is.True, "the candidate sees its own change");
            Assert.That(framework.Current.ManualOverride, Is.False, "nobody else does");
            throw new InvalidOperationException("SaveChanges failed");
        }, CancellationToken.None));

        Assert.That(store.Published, Is.SameAs(before));
        Assert.That(framework.Current, Is.SameAs(frameworkBefore));
        Assert.That(store.Published!.EffectiveConfig.CriticalThresholdWatts, Is.EqualTo(1300));
        Assert.That(store.Published.RecentEvents.Select(e => e.Title), Does.Not.Contain("Should not appear"));
        Assert.That(store.Published.Outlets[0].PendingCommandId, Is.Null);

        // Returning without MarkCommitted (no SaveChanges) is also no publication.
        await coordinator.ExecuteAsync(m =>
        {
            m.UpdateFramework(s => s with { ManualOverride = true });
            m.StageOutlet(Entity(1));
            return Task.FromResult(0);
        }, CancellationToken.None);
        Assert.That(store.Published, Is.SameAs(before));
        Assert.That(framework.Current.ManualOverride, Is.False);
    }

    [Test]
    public async Task Commit_PublishesOnlyAfterTheHandlerCompletes_WithVersions()
    {
        var (store, framework, coordinator, clock) = await HydratedAsync();
        var before = store.Published!;

        await coordinator.ExecuteAsync(m =>
        {
            var outlet = Entity(2);
            outlet.Status = OutletStatus.Disconnected;
            outlet.PendingCommandId = Guid.Parse("22222222-0000-0000-0000-000000000000");
            outlet.LastSeen = T0.AddTicks(12_345_678); // sub-microsecond ticks
            m.StageOutlet(outlet);
            m.StageEvent(new PowerEvent { Id = 41, Timestamp = clock.Peek(), Title = "Manual relay action", CreatedBy = "admin-1" });
            m.UpdateFramework(s => s with { ManualOverride = true });
            m.MarkCommitted();
            Assert.That(store.Published, Is.SameAs(before), "publication waits for the handler to return");
            return Task.FromResult(0);
        }, CancellationToken.None);

        var after = store.Published!;
        Assert.That(after, Is.Not.SameAs(before));
        Assert.That(after.LiveVersion, Is.EqualTo(before.LiveVersion + 1));
        Assert.That(after.ConfigVersion, Is.EqualTo(before.ConfigVersion), "a status change is not a configuration change");
        Assert.That(after.Outlets[1].Status, Is.EqualTo(OutletStatus.Disconnected));
        Assert.That(after.Outlets[1].LastSeen!.Value.Ticks % 10, Is.Zero, "timestamps carry PostgreSQL's microsecond precision");
        Assert.That(after.LatestEvent!.Title, Is.EqualTo("Manual relay action"));
        Assert.That(after.LatestEvent.Actor, Is.EqualTo("admin-1"));
        Assert.That(after.Framework.ManualOverride, Is.True);
        Assert.That(framework.Current, Is.SameAs(after.Framework));
        Assert.That(before.Outlets[1].Status, Is.EqualTo(OutletStatus.Active), "a captured snapshot never changes");

        await coordinator.ExecuteAsync(m =>
        {
            var config = Config();
            config.CriticalThresholdWatts = 1200;
            m.StageConfig(config);
            m.MarkCommitted();
            return Task.FromResult(0);
        }, CancellationToken.None);
        Assert.That(store.Published!.ConfigVersion, Is.EqualTo(after.ConfigVersion + 1));
        Assert.That(GetDeviceConfigQueryHandler.Project(store.Published).CriticalThresholdWatts, Is.EqualTo(1200));
    }

    [Test]
    public async Task Commit_DoesNotPublishAnUnsavedFallbackConfig()
    {
        var (store, _, coordinator, _) = await HydratedAsync();
        var before = store.Published!.Config;

        // Handlers fall back to `new PowerSystemConfig()` (Id 0) when no row
        // exists and never save it; ingest still sets acquisition fields on it.
        await coordinator.ExecuteAsync(m =>
        {
            m.StageConfig(new PowerSystemConfig { LastAcquisitionSessionId = Guid.NewGuid(), LastAcquisitionSequence = 9 });
            m.MarkCommitted();
            return Task.FromResult(0);
        }, CancellationToken.None);

        Assert.That(store.Published!.Config, Is.SameAs(before));
    }

    [Test]
    public async Task ConcurrentMutations_AreSerialized_AndLoseNoUpdates()
    {
        var (store, framework, coordinator, _) = await HydratedAsync();
        var active = 0;
        var maxActive = 0;

        var tasks = Enumerable.Range(0, 200).Select(i => Task.Run(() => coordinator.ExecuteAsync(async m =>
        {
            var now = Interlocked.Increment(ref active);
            InterlockedMax(ref maxActive, now);
            var seen = m.Framework.ConsecutiveOverLimitBatches;
            await Task.Yield();
            m.UpdateFramework(s => s with { ConsecutiveOverLimitBatches = seen + 1 });
            var outlet = Entity(1 + (i % 4));
            outlet.CurrentWatts = i;
            m.StageOutlet(outlet);
            m.StageEvent(new PowerEvent { Id = 1000 + i, Timestamp = T0.AddMilliseconds(i), Title = $"e{i}" });
            m.MarkCommitted();
            Interlocked.Decrement(ref active);
            return seen;
        }, CancellationToken.None))).ToList();

        var seenValues = await Task.WhenAll(tasks);

        Assert.That(maxActive, Is.EqualTo(1), "one mutation at a time");
        Assert.That(seenValues.OrderBy(v => v), Is.EqualTo(Enumerable.Range(0, 200)), "each mutation saw the previous one's published result");
        Assert.That(framework.Current.ConsecutiveOverLimitBatches, Is.EqualTo(200));
        Assert.That(store.Published!.LiveVersion, Is.EqualTo(201));
        Assert.That(store.Published.RecentEvents, Has.Length.EqualTo(PowerRuntimeSnapshot.RecentEventCapacity));
        Assert.That(store.Published.RecentEvents[0].Title, Is.EqualTo("e199"), "newest event first");
    }

    [Test]
    public async Task RelayReport_IsKeptApartFromAcknowledgement()
    {
        var (store, _, coordinator, clock) = await HydratedAsync();
        var pending = Guid.NewGuid();
        await coordinator.ExecuteAsync(m =>
        {
            var outlet = Entity(1);
            outlet.PendingCommandId = pending;
            outlet.PendingRelayClosed = false;
            m.StageOutlet(outlet);
            m.StageRelayReport(1, relayClosed: false, commandId: Guid.NewGuid(), clock.Peek());
            m.MarkCommitted();
            return Task.FromResult(0);
        }, CancellationToken.None);

        var outlet1 = store.Published!.Outlets[0];
        Assert.That(outlet1.LastRelayReport, Is.Not.Null);
        Assert.That(outlet1.LastRelayReport!.CommandId, Is.Not.EqualTo(pending));
        Assert.That(outlet1.PendingCommandId, Is.EqualTo(pending));
        Assert.That(outlet1.PendingCommandAcknowledgedAtUtc, Is.Null, "a non-matching report is not an acknowledgement");
    }

    [Test]
    public async Task LiveOnlyPublication_PublishesMeasurementsButNoDurableFields()
    {
        var (store, framework, coordinator, clock) = await HydratedAsync();
        var before = store.Published!;

        await coordinator.ExecuteAsync(m =>
        {
            var outlet = Entity(1);
            outlet.CurrentWatts = 432;
            outlet.LastSeen = clock.Peek();
            outlet.Status = OutletStatus.Disconnected;
            outlet.PendingCommandId = Guid.NewGuid();
            m.StageOutlet(outlet);
            m.StageReading(new TelemetryReading { OutletId = 1, Timestamp = clock.Peek(), Voltage = 230 });
            m.StageEvent(new PowerEvent { Id = 77, Timestamp = clock.Peek(), Title = "durable" });
            m.UpdateFramework(s => s with { ManualOverride = true });
            m.MarkLiveOnly();
            return Task.FromResult(0);
        }, CancellationToken.None);

        var after = store.Published!;
        Assert.That(after.Outlets[0].CurrentWatts, Is.EqualTo(432));
        Assert.That(after.Outlets[0].Status, Is.EqualTo(before.Outlets[0].Status));
        Assert.That(after.Outlets[0].PendingCommandId, Is.Null);
        Assert.That(after.RecentEvents, Is.EqualTo(before.RecentEvents));
        Assert.That(after.Framework, Is.SameAs(before.Framework));
        Assert.That(framework.Current.ManualOverride, Is.False);
        Assert.That(after.VoltageWindow.Samples, Has.Length.EqualTo(before.VoltageWindow.Samples.Length + 1));
    }

    // ---- Freshness and projections ------------------------------------------

    [Test]
    public async Task Freshness_ExpiresAgainstTheCurrentClock_WithoutRefresh()
    {
        var hydrator = new FakeHydrator();
        var store = new PowerRuntimeStore(true, new LoadSheddingStateStore(), hydrator);
        var snapshot = await store.GetAsync();
        var lastSeen = snapshot.Outlets.Max(o => o.LastSeen)!.Value;

        var fresh = GetDashboardStateQueryHandler.Project(store.Published!, lastSeen.AddSeconds(30));
        Assert.That(fresh.DeviceOnline, Is.True);
        Assert.That(fresh.MainsVolts, Is.Not.Null);
        Assert.That(fresh.Ina226, Is.Not.Null);

        var stale = GetDashboardStateQueryHandler.Project(store.Published!, lastSeen.AddSeconds(30).AddTicks(10));
        Assert.That(stale.DeviceOnline, Is.False);
        Assert.That(stale.MainsVolts, Is.Null);
        Assert.That(stale.Ina226, Is.Null);
        Assert.That(stale.Outlets.Select(o => o.Watts), Is.EqualTo(fresh.Outlets.Select(o => o.Watts)), "last measurements are kept, only freshness changed");
        Assert.That(hydrator.Calls, Is.EqualTo(1), "expiry needs no refresh");
    }

    [Test]
    public void VoltageWindow_MatchesTheBaselineRule_AcrossSamplesAndExpiryBoundaries()
    {
        var mains = new[] { 1, 2, 3, 4 };
        var all = new List<RuntimeVoltageSample>();
        var window = RuntimeVoltageWindow.Empty;
        var random = new Random(20261019);

        // Publish 2 minutes of 1 Hz batches (with a monitor row and zero-volt
        // rows), checking the projection against a brute-force evaluation of
        // the legacy rule over EVERY sample ever stored, at many cutoffs.
        for (var second = 0; second < 120; second++)
        {
            var at = T0.AddSeconds(second);
            var batch = Enumerable.Range(1, 5)
                .Select(id => new RuntimeVoltageSample(id, at, id == 5 ? 24.1 : (second % 17 == 0 && id == 2 ? 0 : 220 + random.NextDouble() * 20)))
                .ToList();
            all.AddRange(batch);
            window = window.Append(batch, at);

            foreach (var offset in new[] { 0.0, 0.0001, 0.5, 29.999, 30.0, 30.000001 })
            {
                var now = at.AddSeconds(offset);
                var cutoff = now.AddSeconds(-30);
                var expected = all.Where(s => s.Timestamp >= cutoff && s.Voltage > 0 && mains.Contains(s.OutletId)).Select(s => s.Voltage).ToList();
                var actual = window.Average(cutoff, mains);
                if (expected.Count == 0)
                {
                    Assert.That(actual, Is.Null, $"t={second}s +{offset}");
                }
                else
                {
                    Assert.That(actual, Is.EqualTo(expected.Average()).Within(1e-9), $"t={second}s +{offset}");
                }
            }
        }

        Assert.That(window.Samples.Length, Is.LessThanOrEqualTo(31 * 5), "only samples that can still count are kept");
        Assert.That(window.DroppedForCapacity, Is.Zero);
        // Inclusive boundary: a sample exactly 30 s old still counts.
        var single = RuntimeVoltageWindow.Empty.Append([new RuntimeVoltageSample(1, T0, 230)], T0);
        Assert.That(single.Average(T0, [1]), Is.EqualTo(230));
        Assert.That(single.Average(T0.AddTicks(10), [1]), Is.Null);
    }

    // ---- Single-writer guard -------------------------------------------------

    [Test]
    public void SingleWriterGuard_SecondSameHostWriter_CannotAcquire()
    {
        var directory = Path.Combine(Path.GetTempPath(), "mor-power-runtime-tests", Guid.NewGuid().ToString("N"));
        var identity = SingleWriterGuard.IdentityFor("Host=db.example.invalid;Port=5432;Database=rig;Username=u;Password=fixture-secret-password-token");
        Assert.That(identity, Does.Not.Contain("example").And.Not.Contain("fixture-secret"));
        Assert.That(identity, Is.EqualTo(SingleWriterGuard.IdentityFor("Host=DB.example.invalid;Port=5432;Database=rig;Username=other;Password=other")),
            "credentials do not change the identity; host case does not either");

        using (var first = SingleWriterGuard.Acquire(identity, directory))
        {
            var second = Assert.Throws<SingleWriterGuardException>(() => SingleWriterGuard.Acquire(identity, directory));
            Assert.That(second!.Message, Does.Contain("stop the running instance"));

            // A different rig/database identity is independent.
            using var other = SingleWriterGuard.Acquire(SingleWriterGuard.IdentityFor("Host=db.example.invalid;Port=5432;Database=other"), directory);
        }

        // Released with the first holder; a successor may start.
        using var successor = SingleWriterGuard.Acquire(identity, directory);
        Assert.That(successor.LockPath, Does.StartWith(directory));
    }

    // ---- W-12: no AspNetUsers lookup for logging when cached reads are on ----

    [Test]
    public async Task LoggingBehaviour_CachedReads_TakesNameFromClaims_WithoutIdentityLookup()
    {
        var identity = new Mock<IIdentityService>(MockBehavior.Strict);
        var user = new Mock<IUser>();
        user.Setup(x => x.Id).Returns("user-1");
        var logger = new CapturingLogger<GetDashboardStateQuery>();
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "user-1"), new Claim(ClaimTypes.Name, "administrator@localhost")], "Identity.Application"));

        var behaviour = new LoggingBehaviour<GetDashboardStateQuery>(logger, user.Object, identity.Object,
            Options.Create(new PowerRuntimeOptions { CachedReadsEnabled = true }), [new ClaimsCurrentUserName(() => principal)]);
        await behaviour.Process(new GetDashboardStateQuery(), CancellationToken.None);

        identity.Verify(i => i.GetUserNameAsync(It.IsAny<string>()), Times.Never);
        Assert.That(logger.Messages.Single(), Does.Contain("administrator@localhost").And.Contain("user-1"));

        // No name claim: the user id alone is logged, still without a lookup.
        var anonymousName = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "user-1")], "Identity.Application"));
        behaviour = new LoggingBehaviour<GetDashboardStateQuery>(logger, user.Object, identity.Object,
            Options.Create(new PowerRuntimeOptions { CachedReadsEnabled = true }), [new ClaimsCurrentUserName(() => anonymousName)]);
        await behaviour.Process(new GetDashboardStateQuery(), CancellationToken.None);
        identity.Verify(i => i.GetUserNameAsync(It.IsAny<string>()), Times.Never);
        Assert.That(logger.Messages.Last(), Does.Contain("user-1"));
    }

    [Test]
    public async Task LoggingBehaviour_CachedReadsOff_KeepsTheIdentityLookup()
    {
        var identity = new Mock<IIdentityService>();
        identity.Setup(i => i.GetUserNameAsync("user-1")).ReturnsAsync("from-database");
        var user = new Mock<IUser>();
        user.Setup(x => x.Id).Returns("user-1");
        var logger = new CapturingLogger<GetDashboardStateQuery>();

        var behaviour = new LoggingBehaviour<GetDashboardStateQuery>(logger, user.Object, identity.Object,
            Options.Create(new PowerRuntimeOptions()), [new ClaimsCurrentUserName(() => null)]);
        await behaviour.Process(new GetDashboardStateQuery(), CancellationToken.None);

        identity.Verify(i => i.GetUserNameAsync("user-1"), Times.Once);
        Assert.That(logger.Messages.Single(), Does.Contain("from-database"));
    }

    [Test]
    public async Task PerformanceBehaviour_CachedReads_SlowRequestUsesClaims_WithoutIdentityLookup()
    {
        var identity = new Mock<IIdentityService>(MockBehavior.Strict);
        var user = new Mock<IUser>();
        user.Setup(x => x.Id).Returns("user-1");
        var logger = new CapturingLogger<GetDashboardStateQuery>();
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Name, "administrator@localhost")], "Identity.Application"));

        var behaviour = new PerformanceBehaviour<GetDashboardStateQuery, int>(logger, user.Object, identity.Object,
            Options.Create(new PowerRuntimeOptions { CachedReadsEnabled = true }), [new ClaimsCurrentUserName(() => principal)]);
        // The behaviour times with a real Stopwatch, so the slow path needs real time.
        await behaviour.Handle(new GetDashboardStateQuery(), async _ => { await Task.Delay(550); return 1; }, CancellationToken.None);

        identity.Verify(i => i.GetUserNameAsync(It.IsAny<string>()), Times.Never);
        Assert.That(logger.Messages.Single(), Does.Contain("Long Running").And.Contain("administrator@localhost"));
    }

    // ---- Helpers -------------------------------------------------------------

    private static async Task<(PowerRuntimeStore Store, LoadSheddingStateStore Framework, PowerMutationCoordinator Coordinator, ControlledTimeProvider Clock)> HydratedAsync()
    {
        var clock = new ControlledTimeProvider();
        var framework = new LoadSheddingStateStore();
        var store = new PowerRuntimeStore(true, framework, new FakeHydrator());
        await store.GetAsync();
        return (store, framework, new PowerMutationCoordinator(framework, store, clock), clock);
    }

    private static PowerSystemConfig Config() => new() { Id = 1 };

    private static Outlet Entity(int id) => new()
    {
        Id = id,
        Name = $"Outlet {id}",
        RelayChannel = id == 5 ? "INA226 monitor" : $"relay-{id}",
        RatedVoltageVolts = id == 5 ? 5 : 220,
        Status = OutletStatus.Active,
        AllowanceWatts = 300,
        CurrentWatts = 10 * id,
        LastSeen = T0,
    };

    private static void InterlockedMax(ref int target, int value)
    {
        int current;
        while (value > (current = Volatile.Read(ref target)) && Interlocked.CompareExchange(ref target, value, current) != current)
        {
        }
    }

    private sealed class FakeHydrator : IPowerRuntimeHydrator
    {
        private int _calls;

        public TaskCompletionSource? Gate { get; init; }

        public int Failures { get; set; }

        public int Calls => Volatile.Read(ref _calls);

        public async Task<PowerRuntimeSnapshot> LoadAsync(CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _calls);
            if (Gate is not null) await Gate.Task;
            if (call <= Failures) throw new InvalidOperationException("database unavailable");

            return new PowerRuntimeSnapshot
            {
                HydratedAtUtc = T0,
                Config = RuntimeConfig.From(Config()),
                Outlets = Enumerable.Range(1, 5).Select(id => RuntimeOutlet.From(Entity(id))).ToImmutableArray(),
                RecentEvents = PowerRuntimeSnapshot.OrderEvents([new RuntimeEvent(1, T0.AddSeconds(-5), "Seeded", "", EventSeverity.Info, null)]),
                LatestIna = new RuntimeInaSample(24.1, 1.0, 0.01, 0.24, T0),
                VoltageWindow = RuntimeVoltageWindow.Empty.Append(
                    Enumerable.Range(1, 5).Select(id => new RuntimeVoltageSample(id, T0, id == 5 ? 24.1 : 230)), T0),
            };
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }
}
