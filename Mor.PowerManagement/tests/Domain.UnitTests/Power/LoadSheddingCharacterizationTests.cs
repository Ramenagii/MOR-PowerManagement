using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;
using NUnit.Framework;
using Shouldly;

namespace Mor.PowerManagement.Domain.UnitTests.Power;

// PLAN-0001 Spec B characterization of LoadSheddingEngine at baseline 54c4885.
// Every timestamp is supplied explicitly (the engine never reads a clock), so
// no test sleeps. Expectations describe executable behavior, including the
// places where it differs from MUST_READ.md (see ControlCharacterization.md).
public class LoadSheddingCharacterizationTests
{
    private const double PLimit = 1300;

    private static readonly DateTimeOffset T0 = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(double seconds) => T0.AddSeconds(seconds);

    private static OutletLoadSnapshot Outlet(
        int id,
        OutletPriority priority,
        double watts,
        DateTimeOffset? lastSeen,
        OutletStatus status = OutletStatus.Active,
        double allowance = 2000,
        bool isProtected = false,
        bool manualHold = false,
        bool recoveryLockout = false,
        int attempts = 0)
        => new(id, priority, status, watts, allowance, lastSeen, $"Outlet {id}", isProtected, manualHold, recoveryLockout, attempts);

    // Two unprotected outlets totalling 1400 W, every reading fresh at `now`.
    private static IReadOnlyList<OutletLoadSnapshot> OverloadedRig(DateTimeOffset now) => new[]
    {
        Outlet(1, OutletPriority.Low, 700, now),
        Outlet(2, OutletPriority.Medium, 700, now),
    };

    private static (LoadSheddingDecision Decision, LoadSheddingState State) Run(
        LoadSheddingState state, DateTimeOffset now, IReadOnlyList<OutletLoadSnapshot>? outlets = null)
    {
        var decision = LoadSheddingEngine.Evaluate(outlets ?? OverloadedRig(now), PLimit, state, now);
        return (decision, decision.NextState);
    }

    [Test]
    public void ShedSelection_UsesTierThenDescendingWattsThenId()
    {
        var outlets = new[]
        {
            Outlet(1, OutletPriority.Critical, 900, T0),
            Outlet(2, OutletPriority.High, 100, T0),
            Outlet(3, OutletPriority.Medium, 50, T0),
            Outlet(4, OutletPriority.Medium, 200, T0),
            Outlet(6, OutletPriority.Low, 10, T0),
            Outlet(7, OutletPriority.Low, 10, T0),
            Outlet(8, OutletPriority.Medium, 200, T0),
            // Unknown ranks map to Important (same tier as High).
            Outlet(9, (OutletPriority)99, 150, T0),
        };

        LoadSheddingEngine.SelectNextShed(outlets, 20).Select(o => o.Id)
            .ShouldBe(new[] { 6, 7, 4, 8, 3, 9, 2, 1 });
        LoadResponseEvaluator.SelectSheddingCandidates(outlets, 3).ShouldBe(new[] { 6, 7, 4 });
        LoadSheddingEngine.SelectNextShed(outlets, 0).ShouldBeEmpty();
        LoadSheddingEngine.SelectNextShed(outlets, -1).ShouldBeEmpty();
        LoadTierMapper.ToTier((OutletPriority)99).ShouldBe(LoadTier.Important);
    }

    [Test]
    public void ShedSelection_ExcludesProtectedAndMonitorOutlets()
    {
        var outlets = new[]
        {
            Outlet(1, OutletPriority.Low, 500, T0, isProtected: true),
            Outlet(2, OutletPriority.Low, 400, T0, status: OutletStatus.Disconnected),
            Outlet(3, OutletPriority.Low, 300, T0, status: OutletStatus.Restricted),
            Outlet(4, OutletPriority.Medium, 100, T0, status: OutletStatus.Standby),
            Outlet(5, OutletPriority.Low, 999, T0),
            Outlet(6, OutletPriority.High, 50, T0),
        };

        LoadSheddingEngine.SelectNextShed(outlets, 10).Select(o => o.Id).ShouldBe(new[] { 4, 6 });
    }

    [Test]
    public void CriticalPriorityAlone_DoesNotImplyProtection()
    {
        var critical = Outlet(1, OutletPriority.Critical, 1400, T0);
        LoadTierMapper.IsAutoSheddable(critical).ShouldBeTrue();

        var state = LoadSheddingState.Initial;
        LoadSheddingDecision decision = null!;
        for (var second = 0; second <= 3; second++)
        {
            var now = At(second);
            (decision, state) = Run(state, now, new[] { Outlet(1, OutletPriority.Critical, 1400, now) });
        }

        decision.Action.ShouldBe(LoadSheddingAction.Shed);
        decision.OutletId.ShouldBe(1);
        decision.Tier.ShouldBe(LoadTier.Critical);
        state.ShedLedger.Single().ShouldBe(new ShedRecord(1, LoadTier.Critical, 1400, At(3)));
    }

    [Test]
    public void OutletAllowanceTrip_UsesFirstFreshAtOrAboveAllowance()
    {
        // At the allowance on the very first fresh batch: shed immediately.
        var decision = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Critical, 300, T0, allowance: 300), Outlet(2, OutletPriority.Low, 10, T0, allowance: 300) },
            PLimit, LoadSheddingState.Initial, T0);
        decision.Action.ShouldBe(LoadSheddingAction.Shed);
        decision.OutletId.ShouldBe(1);
        decision.ConsecutiveOverLimitBatches.ShouldBe(1);
        decision.OverLimitConfirmationSeconds.ShouldBe(LoadSheddingSettings.OutletAllowanceConfirmationBatches);
        decision.NextState.ShedLedger.Single().ShouldBe(new ShedRecord(1, LoadTier.Critical, 300, T0, OutletAllowanceTrip: true));
        decision.NextState.ConsecutiveOutletOverLimitBatches.ShouldNotContainKey(1);
        decision.NextState.ConsecutiveOutletOverLimitBatches[2].ShouldBe(0);
        decision.Detail.ShouldBe("Outlet 1 drew 300 W, at or above its 300 W outlet limit. Opening its relay.");

        // Just below the allowance: nothing.
        Evaluate(Outlet(1, OutletPriority.Low, 299.999, T0, allowance: 300)).Action.ShouldBe(LoadSheddingAction.None);

        // Freshness boundary is inclusive at 30 s; one millisecond older is ignored.
        Evaluate(Outlet(1, OutletPriority.Low, 300, T0.AddSeconds(-30), allowance: 300)).Action.ShouldBe(LoadSheddingAction.Shed);
        Evaluate(Outlet(1, OutletPriority.Low, 300, T0.AddSeconds(-30.001), allowance: 300)).Action.ShouldBe(LoadSheddingAction.None);
        Evaluate(Outlet(1, OutletPriority.Low, 300, null, allowance: 300)).Action.ShouldBe(LoadSheddingAction.None);

        // Protected, monitor-only and non-energized outlets never trip.
        var protectedTrip = Evaluate(Outlet(1, OutletPriority.Low, 400, T0, allowance: 300, isProtected: true));
        protectedTrip.Action.ShouldBe(LoadSheddingAction.None);
        // The protected outlet's counter still advances; it is only excluded from selection.
        protectedTrip.NextState.ConsecutiveOutletOverLimitBatches[1].ShouldBe(1);
        Evaluate(Outlet(5, OutletPriority.Low, 400, T0, allowance: 10)).Action.ShouldBe(LoadSheddingAction.None);
        Evaluate(Outlet(1, OutletPriority.Low, 400, T0, allowance: 300, status: OutletStatus.Disconnected)).Action.ShouldBe(LoadSheddingAction.None);

        // Several over allowance: largest excess first, then lowest id.
        Evaluate(
                Outlet(2, OutletPriority.Low, 350, T0, allowance: 300),
                Outlet(3, OutletPriority.Critical, 400, T0, allowance: 300))
            .OutletId.ShouldBe(3);
        Evaluate(
                Outlet(4, OutletPriority.Low, 400, T0, allowance: 300),
                Outlet(3, OutletPriority.Low, 400, T0, allowance: 300))
            .OutletId.ShouldBe(3);

        // The allowance trip outranks system-overload confirmation and replaces
        // any existing ledger record for the same outlet.
        var prior = LoadSheddingState.Initial with
        {
            ShedLedger = new[] { new ShedRecord(2, LoadTier.Nonessential, 50, T0.AddMinutes(-5)), new ShedRecord(1, LoadTier.Nonessential, 10, T0.AddMinutes(-4)) },
            BelowRecoveryLimitSinceUtc = T0.AddSeconds(-10),
            FaultLatched = true,
        };
        var overloaded = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Low, 1000, T0, allowance: 900), Outlet(3, OutletPriority.Low, 800, T0) },
            PLimit, prior, T0);
        overloaded.Action.ShouldBe(LoadSheddingAction.Shed);
        overloaded.OutletId.ShouldBe(1);
        overloaded.NextState.ShedLedger.Select(r => r.OutletId).ShouldBe(new[] { 2, 1 });
        overloaded.NextState.ShedLedger[1].OutletAllowanceTrip.ShouldBeTrue();
        overloaded.NextState.BelowRecoveryLimitSinceUtc.ShouldBeNull();
        overloaded.NextState.FaultLatched.ShouldBeFalse();
        overloaded.NextState.OverLimitSinceUtc.ShouldBeNull();

        static LoadSheddingDecision Evaluate(params OutletLoadSnapshot[] outlets)
            => LoadSheddingEngine.Evaluate(outlets, PLimit, LoadSheddingState.Initial, T0);
    }

    // Samples arrive every `cadenceSeconds`; the shed happens on the first
    // sample whose elapsed time since the first over-limit sample is >= 3 s.
    [TestCase(1.0, 4)]
    [TestCase(1.5, 3)]
    [TestCase(5.0, 2)]
    [TestCase(3.0, 2)]
    public void SystemOverload_RequiresThreeElapsedSeconds(double cadenceSeconds, int samplesUntilShed)
    {
        var state = LoadSheddingState.Initial;
        for (var sample = 1; sample <= samplesUntilShed; sample++)
        {
            var now = At((sample - 1) * cadenceSeconds);
            var (decision, next) = Run(state, now);

            next.OverLimitSinceUtc.ShouldBe(T0);
            next.LastOverLimitSampleUtc.ShouldBe(now);
            decision.ConsecutiveOverLimitBatches.ShouldBe(sample);
            decision.OverLimitConfirmationSeconds.ShouldBe(3);

            if (sample < samplesUntilShed)
            {
                decision.Action.ShouldBe(LoadSheddingAction.None);
                decision.Detail.ShouldStartWith("P_total 1400.0 W is at or above P_limit 1300.0 W; sustained for ");
                next.ShedLedger.ShouldBeEmpty();
            }
            else
            {
                decision.Action.ShouldBe(LoadSheddingAction.Shed);
                decision.OutletId.ShouldBe(1);
                decision.Tier.ShouldBe(LoadTier.Nonessential);
                next.ShedLedger.Single().ShouldBe(new ShedRecord(1, LoadTier.Nonessential, 700, now));
            }

            state = next;
        }
    }

    [Test]
    public void SystemOverload_RequiresThreeElapsedSeconds_ExactBoundaryAndEquality()
    {
        // 2.999 s is not enough; 3.000 s is.
        var (first, s1) = Run(LoadSheddingState.Initial, T0);
        first.Action.ShouldBe(LoadSheddingAction.None);
        var (almost, s2) = Run(s1, At(2.999));
        almost.Action.ShouldBe(LoadSheddingAction.None);
        Run(s2, At(3.0)).Decision.Action.ShouldBe(LoadSheddingAction.Shed);

        // P_total exactly equal to P_limit counts as overload.
        var exact = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 650, now),
            Outlet(2, OutletPriority.Low, 650, now),
        });
        var (e0, es0) = Run(LoadSheddingState.Initial, T0, exact(T0));
        e0.NextState.OverLimitSinceUtc.ShouldBe(T0);
        Run(es0, At(3), exact(At(3))).Decision.Action.ShouldBe(LoadSheddingAction.Shed);
    }

    [TestCase(6.0, true)]
    [TestCase(6.001, false)]
    [TestCase(10.0, false)]
    public void OverloadGap_AtSixSecondsContinues_AboveSixRestarts(double gapSeconds, bool continues)
    {
        var (_, state) = Run(LoadSheddingState.Initial, T0);
        var (decision, next) = Run(state, At(gapSeconds));

        if (continues)
        {
            decision.Action.ShouldBe(LoadSheddingAction.Shed);
            next.OverLimitSinceUtc.ShouldBe(T0);
            decision.ConsecutiveOverLimitBatches.ShouldBe(2);
        }
        else
        {
            decision.Action.ShouldBe(LoadSheddingAction.None);
            next.OverLimitSinceUtc.ShouldBe(At(gapSeconds));
            decision.ConsecutiveOverLimitBatches.ShouldBe(1);
        }
    }

    [Test]
    public void BackwardSampleTime_RestartsOverloadConfirmation()
    {
        var (_, s0) = Run(LoadSheddingState.Initial, T0);
        var (_, s2) = Run(s0, At(2));
        s2.OverLimitSinceUtc.ShouldBe(T0);

        var (backward, s1) = Run(s2, At(1));
        backward.Action.ShouldBe(LoadSheddingAction.None);
        backward.ConsecutiveOverLimitBatches.ShouldBe(1);
        s1.OverLimitSinceUtc.ShouldBe(At(1));
        s1.LastOverLimitSampleUtc.ShouldBe(At(1));

        Run(s1, At(3.999)).Decision.Action.ShouldBe(LoadSheddingAction.None);
        Run(s1, At(4)).Decision.Action.ShouldBe(LoadSheddingAction.Shed);
    }

    [TestCase(double.NaN, "impossible power reading (NaN).")]
    [TestCase(-1.0, "impossible power reading (-1).")]
    [TestCase(5000.001, "implausible power reading (5000 W).")]
    public void SensorFault_PrecedesSheddingAndLatchesAlarm(double badWatts, string reason)
    {
        var armed = LoadSheddingState.Initial with
        {
            ConsecutiveOverLimitBatches = 2,
            OverLimitSinceUtc = At(-2),
            LastOverLimitSampleUtc = At(-1),
            ConsecutiveOutletOverLimitBatches = new Dictionary<int, int> { [1] = 3 },
            ShedLedger = new[] { new ShedRecord(3, LoadTier.Deferrable, 100, At(-60)) },
        };

        // Outlet 1 is over its allowance and the rig is overloaded, yet the
        // fault on outlet 2 wins.
        var decision = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Low, 1400, T0, allowance: 300), Outlet(2, OutletPriority.Low, badWatts, T0) },
            PLimit, armed, T0);

        decision.Action.ShouldBe(LoadSheddingAction.Alarm);
        decision.OutletId.ShouldBeNull();
        decision.Detail.ShouldBe($"Measurement fault on 1 branch(es): Outlet 2 - {reason}. Automatic shedding suspended; the rig is NOT assumed safe.");
        decision.NextState.FaultLatched.ShouldBeTrue();
        decision.NextState.ConsecutiveOverLimitBatches.ShouldBe(0);
        decision.NextState.OverLimitSinceUtc.ShouldBeNull();
        decision.NextState.LastOverLimitSampleUtc.ShouldBeNull();
        decision.NextState.ConsecutiveOutletOverLimitBatches.ShouldBeEmpty();
        decision.NextState.ShedLedger.ShouldBe(armed.ShedLedger);
    }

    [Test]
    public void SensorFault_StalenessOnlyFaultsAboveLimit_AndLatchClearsOnNextCleanBatch()
    {
        // 5000 W exactly is plausible.
        LoadSheddingEngine.InspectSensorHealth(new[] { Outlet(1, OutletPriority.Low, 5000, T0) }, PLimit, 0, T0).ShouldBeEmpty();

        // Stale or never-seen readings fault only when P_total is strictly above P_limit;
        // the inspection covers non-energized and monitor outlets too.
        var stale = Outlet(3, OutletPriority.Low, 0, T0.AddSeconds(-30.001), status: OutletStatus.Disconnected);
        var never = Outlet(5, OutletPriority.Low, 0, null);
        var boundary = Outlet(4, OutletPriority.Low, 0, T0.AddSeconds(-30));
        LoadSheddingEngine.InspectSensorHealth(new[] { stale, never, boundary }, PLimit, 1300.001, T0)
            .Select(f => f.OutletId).ShouldBe(new[] { 3, 5 });
        LoadSheddingEngine.InspectSensorHealth(new[] { stale, never }, PLimit, 1300, T0).ShouldBeEmpty();

        // So at exactly P_limit a stale branch does not suppress the overload path.
        var exactLimitWithStale = new[]
        {
            Outlet(1, OutletPriority.Low, 1300, T0),
            Outlet(2, OutletPriority.Low, 0, null, status: OutletStatus.Disconnected),
        };
        LoadSheddingEngine.Evaluate(exactLimitWithStale, PLimit, LoadSheddingState.Initial, T0).Action.ShouldBe(LoadSheddingAction.None);
        LoadSheddingEngine.Evaluate(exactLimitWithStale, PLimit, LoadSheddingState.Initial, T0).NextState.OverLimitSinceUtc.ShouldBe(T0);

        var overloadWithNever = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Low, 1400, T0), Outlet(2, OutletPriority.Low, 0, null, status: OutletStatus.Disconnected) },
            PLimit, LoadSheddingState.Initial, T0);
        overloadWithNever.Action.ShouldBe(LoadSheddingAction.Alarm);
        overloadWithNever.Detail.ShouldContain("Outlet 2 - no reading has ever been received for this branch.");

        // "Latched" lasts only until the next clean evaluation.
        var clean = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Low, 100, At(1)) }, PLimit, overloadWithNever.NextState, At(1));
        clean.Action.ShouldBe(LoadSheddingAction.None);
        clean.NextState.FaultLatched.ShouldBeFalse();
    }

    [Test]
    public void ManualOverride_SuppressesAutomaticSwitching()
    {
        var overridden = LoadSheddingState.Initial with { ManualOverride = true };

        // No allowance trip, and the outlet counter does not advance.
        var allowance = LoadSheddingEngine.Evaluate(
            new[] { Outlet(1, OutletPriority.Low, 500, T0, allowance: 300) }, PLimit, overridden, T0);
        allowance.Action.ShouldBe(LoadSheddingAction.None);
        allowance.NextState.ConsecutiveOutletOverLimitBatches[1].ShouldBe(0);

        // Sustained overload is confirmed but nothing is shed.
        var state = overridden;
        LoadSheddingDecision decision = null!;
        for (var second = 0; second <= 4; second++)
        {
            (decision, state) = Run(state, At(second));
        }
        decision.Action.ShouldBe(LoadSheddingAction.None);
        decision.ConsecutiveOverLimitBatches.ShouldBe(5);
        decision.Detail.ShouldBe("P_total 1400.0 W is at or above P_limit 1300.0 W, but the operator has disabled automatic prioritisation. Manual action required.");
        state.ShedLedger.ShouldBeEmpty();

        // A healthy rig with shed branches waits out the recovery period, then
        // refuses to restore and RESETS the recovery clock.
        var shed = overridden with { ShedLedger = new[] { new ShedRecord(1, LoadTier.Nonessential, 700, T0) } };
        var healthy = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Low, 100, now),
        });
        var (wait, waiting) = Run(shed, At(1), healthy(At(1)));
        wait.Detail.ShouldBe("Timed recovery wait: 0/55 s; holding shed branches.");
        var (refused, afterRefusal) = Run(waiting, At(56), healthy(At(56)));
        refused.Action.ShouldBe(LoadSheddingAction.None);
        refused.Detail.ShouldBe("1 branch(es) are shed and the rig is healthy, but the operator has disabled automatic prioritisation. Manual restoration required.");
        afterRefusal.BelowRecoveryLimitSinceUtc.ShouldBeNull();
        afterRefusal.ShedLedger.Count.ShouldBe(1);
    }

    [Test]
    public void UnsheddableOverload_AlarmsWithoutAssumingSafety()
    {
        var rig = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Critical, 1000, now, isProtected: true),
            Outlet(2, OutletPriority.Low, 400, now, isProtected: true),
            Outlet(3, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(5, OutletPriority.Low, 3, now, status: OutletStatus.Standby),
        });

        var state = LoadSheddingState.Initial;
        var actions = new List<LoadSheddingAction>();
        for (var second = 0; second <= 5; second++)
        {
            var (decision, next) = Run(state, At(second), rig(At(second)));
            actions.Add(decision.Action);
            if (decision.Action == LoadSheddingAction.Alarm)
            {
                decision.Detail.ShouldBe(
                    "P_total 1400.0 W is still at or above P_limit 1300.0 W after shedding every eligible branch. " +
                    "The remaining load is highest-priority load the framework will not disconnect automatically; " +
                    "the rig is NOT assumed safe and needs operator intervention.");
                next.FaultLatched.ShouldBeTrue();
                next.OverLimitSinceUtc.ShouldBe(T0);
            }
            state = next;
        }

        // Confirmation for 3 s, then an alarm on EVERY subsequent batch.
        actions.ShouldBe(new[]
        {
            LoadSheddingAction.None, LoadSheddingAction.None, LoadSheddingAction.None,
            LoadSheddingAction.Alarm, LoadSheddingAction.Alarm, LoadSheddingAction.Alarm,
        });
        state.ShedLedger.ShouldBeEmpty();
    }

    [TestCase(0.0)]
    [TestCase(1169.999)]
    [TestCase(1170.0)]
    [TestCase(1250.0)]
    [TestCase(1299.999)]
    public void Recovery_UsesExistingHysteresisBoundaryAnd55SecondWait(double remainingWatts)
    {
        LoadSheddingEngine.ComputeRecoveryLimit(1300).ShouldBe(1170, 1e-9);
        LoadSheddingEngine.ComputeRecoveryLimit(0).ShouldBe(0);
        LoadSheddingEngine.ComputeRecoveryLimit(-10).ShouldBe(0);

        var rig = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Critical, remainingWatts, now),
        });
        var shed = LoadSheddingState.Initial with { ShedLedger = new[] { new ShedRecord(1, LoadTier.Nonessential, 700, T0) } };

        // The recovery clock starts on the first non-overload batch, whatever
        // P_total is: the 1170 W recovery limit is reported but does not gate
        // restoration.
        var (first, s1) = Run(shed, At(1), rig(At(1)));
        first.Action.ShouldBe(LoadSheddingAction.None);
        first.RecoveryLimitWatts.ShouldBe(1170, 1e-9);
        s1.BelowRecoveryLimitSinceUtc.ShouldBe(At(1));

        var (almost, s2) = Run(s1, At(55.999), rig(At(55.999)));
        almost.Action.ShouldBe(LoadSheddingAction.None);
        almost.Detail.ShouldBe("Timed recovery wait: 55/55 s; holding shed branches.");

        var (restore, s3) = Run(s2, At(56), rig(At(56)));
        restore.Action.ShouldBe(LoadSheddingAction.Restore);
        restore.OutletId.ShouldBe(1);
        restore.Detail.ShouldBe("Timed recovery wait of 55 s elapsed. Trial-restoring Outlet 1 (Nonessential); fresh readings determine whether it stays on.");
        s3.ShedLedger.ShouldBeEmpty();
        s3.LastReconnectUtc.ShouldBe(At(56));
        s3.BelowRecoveryLimitSinceUtc.ShouldBeNull();
    }

    [Test]
    public void Recovery_OverLimitSampleRestartsRecoveryWait()
    {
        var shed = LoadSheddingState.Initial with { ShedLedger = new[] { new ShedRecord(1, LoadTier.Nonessential, 700, T0) } };
        var quiet = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Critical, 100, now),
        });
        var loud = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Critical, 1300, now, isProtected: true),
        });

        var (_, s1) = Run(shed, At(1), quiet(At(1)));
        var (_, s2) = Run(s1, At(30), loud(At(30)));
        s2.BelowRecoveryLimitSinceUtc.ShouldBeNull();
        var (_, s3) = Run(s2, At(31), quiet(At(31)));
        s3.BelowRecoveryLimitSinceUtc.ShouldBe(At(31));
        Run(s3, At(56), quiet(At(56))).Decision.Action.ShouldBe(LoadSheddingAction.None);
        Run(s3, At(86), quiet(At(86))).Decision.Action.ShouldBe(LoadSheddingAction.Restore);
    }

    [Test]
    public void Recovery_UsesFiveSecondReconnectSpacingAndExistingOrder()
    {
        // Restore order: most important tier first, then larger shed watts, then id.
        var outlets = new[]
        {
            Outlet(1, OutletPriority.Low, 0, T0, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected),
            Outlet(3, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected),
            Outlet(4, OutletPriority.Medium, 0, T0, status: OutletStatus.Disconnected),
            Outlet(6, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected),
            // Not restorable:
            Outlet(7, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected, manualHold: true),
            Outlet(8, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected, recoveryLockout: true),
            Outlet(9, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected, attempts: 5),
            Outlet(10, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected, isProtected: true),
            Outlet(11, OutletPriority.Critical, 100, T0),
            Outlet(5, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected),
        };
        var ledger = new[] { 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 5, 12 }
            .Select(id => new ShedRecord(id, LoadTier.Critical, id switch { 1 => 500, 2 => 100, 3 => 300, 4 => 200, 6 => 300, _ => 999 }, T0))
            .ToList();
        LoadSheddingEngine.SelectNextRestore(outlets, ledger, 20).Select(o => o.Id).ShouldBe(new[] { 3, 6, 2, 4, 1 });
        LoadTierMapper.IsAutoRestorable(Outlet(9, OutletPriority.Critical, 0, T0, status: OutletStatus.Disconnected, attempts: 4))
            .ShouldBeTrue();

        // The 5 s inter-reconnect gate binds only when the 55 s recovery wait
        // has already elapsed (e.g. a state prepared by forced restoration).
        var two = new Func<DateTimeOffset, IReadOnlyList<OutletLoadSnapshot>>(now => new[]
        {
            Outlet(1, OutletPriority.Low, 0, now, status: OutletStatus.Disconnected),
            Outlet(2, OutletPriority.Medium, 0, now, status: OutletStatus.Disconnected),
            Outlet(3, OutletPriority.Critical, 100, now),
        });
        var ready = LoadSheddingState.Initial with
        {
            ShedLedger = new[] { new ShedRecord(1, LoadTier.Nonessential, 300, T0), new ShedRecord(2, LoadTier.Deferrable, 300, T0) },
            BelowRecoveryLimitSinceUtc = At(-100),
        };
        var gated = Run(ready with { LastReconnectUtc = At(-4.999) }, T0, two(T0)).Decision;
        gated.Action.ShouldBe(LoadSheddingAction.None);
        gated.Detail.ShouldBe("Inter-reconnect delay active; next staged restoration in 0 s.");
        var released = Run(ready with { LastReconnectUtc = At(-5) }, T0, two(T0)).Decision;
        released.Action.ShouldBe(LoadSheddingAction.Restore);
        released.OutletId.ShouldBe(2);

        // In a normal 1 Hz sequence the restore resets the recovery clock, so
        // the second outlet returns 56 s after the first, not 5 s.
        var state = ready with { BelowRecoveryLimitSinceUtc = null };
        var restoreTimes = new List<(double Second, int OutletId)>();
        var disconnected = new HashSet<int> { 1, 2 };
        for (var second = 0; second <= 130; second++)
        {
            var now = At(second);
            var rig = new[]
            {
                Outlet(1, OutletPriority.Low, 0, now, status: disconnected.Contains(1) ? OutletStatus.Disconnected : OutletStatus.Active),
                Outlet(2, OutletPriority.Medium, 0, now, status: disconnected.Contains(2) ? OutletStatus.Disconnected : OutletStatus.Active),
                Outlet(3, OutletPriority.Critical, 100, now),
            };
            var (decision, next) = Run(state, now, rig);
            if (decision.Action == LoadSheddingAction.Restore)
            {
                restoreTimes.Add((second, decision.OutletId!.Value));
                disconnected.Remove(decision.OutletId.Value);
            }
            state = next;
        }

        restoreTimes.ShouldBe(new[] { (55.0, 2), (111.0, 1) });
    }
}
