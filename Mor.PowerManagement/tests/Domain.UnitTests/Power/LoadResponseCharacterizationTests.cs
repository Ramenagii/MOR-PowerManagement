using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;
using NUnit.Framework;
using Shouldly;

namespace Mor.PowerManagement.Domain.UnitTests.Power;

// PLAN-0001 Spec B characterization of the pure load-response rules at
// baseline 54c4885. These tests lock what the code DOES, including behavior
// that disagrees with MUST_READ.md or the manuscript; see
// tests/Infrastructure.IntegrationTests/Power/ControlCharacterization.md for
// the discrepancy list. Do not edit expectations to accommodate a refactor.
public class LoadResponseCharacterizationTests
{
    private static OutletLoadSnapshot Snapshot(
        int id,
        OutletStatus status,
        double watts,
        OutletPriority priority = OutletPriority.Medium,
        double allowance = 300)
        => new(id, priority, status, watts, allowance);

    [Test]
    public void TotalLoad_ExcludesMonitorAndNonEnergizedOutlets()
    {
        var outlets = new[]
        {
            Snapshot(1, OutletStatus.Active, 100.25),
            Snapshot(2, OutletStatus.Standby, 50.5),
            Snapshot(3, OutletStatus.Disconnected, 1000),
            Snapshot(4, OutletStatus.Restricted, 1000),
            // Outlet 5 is the INA226 monitor: excluded even while energized.
            Snapshot(5, OutletStatus.Active, 7),
            Snapshot(6, OutletStatus.Active, 10),
        };

        LoadResponseEvaluator.TotalLoad(outlets).ShouldBe(160.75, 1e-9);
        LoadResponseEvaluator.IsEnergized(OutletStatus.Active).ShouldBeTrue();
        LoadResponseEvaluator.IsEnergized(OutletStatus.Standby).ShouldBeTrue();
        LoadResponseEvaluator.IsEnergized(OutletStatus.Disconnected).ShouldBeFalse();
        LoadResponseEvaluator.IsEnergized(OutletStatus.Restricted).ShouldBeFalse();
        LoadResponseEvaluator.TotalLoad(Array.Empty<OutletLoadSnapshot>()).ShouldBe(0);
    }

    [TestCase(0.0, SystemState.Normal)]
    [TestCase(1039.999, SystemState.Normal)]
    [TestCase(1040.0, SystemState.Warning)]
    [TestCase(1299.999, SystemState.Warning)]
    [TestCase(1300.0, SystemState.Critical)]
    [TestCase(5000.0, SystemState.Critical)]
    public void SystemState_UsesInclusiveWarningAndCriticalBoundaries(double total, SystemState expected)
    {
        LoadResponseEvaluator.GetSystemState(total, 1040, 1300).ShouldBe(expected);
    }

    [TestCase(1000.0, 300.0, ActivationVerdict.Allowed, "POL-02")]
    [TestCase(1000.001, 300.0, ActivationVerdict.Blocked, "POL-03")]
    [TestCase(0.0, 1300.0, ActivationVerdict.Allowed, "POL-02")]
    [TestCase(0.0, 1300.001, ActivationVerdict.Blocked, "POL-03")]
    public void Activation_AllowsExactSystemLimit_BlocksAboveLimit(
        double currentTotal, double allowance, ActivationVerdict verdict, string code)
    {
        var assessment = LoadResponseEvaluator.AssessActivation(currentTotal, allowance, 1300, "Outlet 4");

        assessment.Verdict.ShouldBe(verdict);
        assessment.PolicyCode.ShouldBe(code);
    }

    [Test]
    public void Activation_ReasonTextIsStable()
    {
        LoadResponseEvaluator.AssessActivation(1000.001, 300, 1300, "Outlet 4").Reason
            .ShouldBe("Outlet 4 request denied: 1000 W current load + 300 W allowance exceeds P_limit 1300 W.");
        LoadResponseEvaluator.AssessActivation(1000, 300, 1300, "Outlet 4").Reason
            .ShouldBe("Outlet 4 passed pre-activation assessment; relay may close.");
    }

    // The activation-time allowance check blocks only ABOVE the allowance
    // (strict >), while the runtime allowance trip in LoadSheddingEngine.Evaluate
    // fires AT OR ABOVE it (>=). Both are locked here as observed.
    [TestCase(300.0, ActivationVerdict.Allowed, "POL-02")]
    [TestCase(300.001, ActivationVerdict.Blocked, "POL-03")]
    [TestCase(0.0, ActivationVerdict.Allowed, "POL-02")]
    public void OutletAllowanceAssessment_PreservesExistingBoundary(
        double currentOutletWatts, ActivationVerdict verdict, string code)
    {
        var outlet = new OutletLoadSnapshot(3, OutletPriority.Medium, OutletStatus.Disconnected, currentOutletWatts, 300, Name: "Outlet 3");

        var assessment = LoadSheddingEngine.AssessOutletAllowance(outlet, currentOutletWatts, Array.Empty<int>());

        assessment.Verdict.ShouldBe(verdict);
        assessment.PolicyCode.ShouldBe(code);
        if (verdict == ActivationVerdict.Blocked)
        {
            assessment.Reason.ShouldBe("Outlet 3 is drawing 300 W against a per-outlet allowance of 300 W (Deferrable).");
        }
        else
        {
            assessment.Reason.ShouldBe("Outlet 3 is within its per-outlet allowance of 300 W (Deferrable).");
        }
    }

    [Test]
    public void OutletAllowanceAssessment_ExemptListBypassesCap_ButNoOutletIsExemptToday()
    {
        var critical = new OutletLoadSnapshot(1, OutletPriority.Critical, OutletStatus.Active, 900, 300);

        LoadSheddingEngine.AssessOutletAllowance(critical, 900, new[] { 1 }).Verdict.ShouldBe(ActivationVerdict.Allowed);

        // CriticalTierIsCapExempt=false: the exemption hook returns nothing,
        // so a Critical outlet is held to its own allowance.
        LoadTierMapper.SelectCapExemptOutletIds(new[] { critical }).ShouldBeEmpty();
        LoadTierMapper.SelectCapExemptOutletId(new[] { critical }).ShouldBeNull();
        LoadSheddingEngine.AssessOutletAllowance(critical, 900, LoadTierMapper.SelectCapExemptOutletIds(new[] { critical }))
            .Verdict.ShouldBe(ActivationVerdict.Blocked);
    }
}
