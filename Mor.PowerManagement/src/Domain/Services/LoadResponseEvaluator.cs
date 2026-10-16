using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Domain.Services;

public record OutletLoadSnapshot(
    int Id,
    OutletPriority Priority,
    OutletStatus Status,
    double Watts,
    double AllowanceWatts,
    // Optional so every existing 5-argument construction keeps compiling. Only
    // the framework's sensor-health check reads it: a branch that reports no
    // fresh sample is UNKNOWN, not zero (LoadSheddingSettings.SensorStalenessSeconds).
    DateTimeOffset? LastSeen = null,

    // Optional, default empty so existing construction sites keep compiling.
    // Used only for operator-facing messages; identity is always Id.
    string Name = "",
    bool IsProtected = false,
    bool ManualHold = false,
    bool RecoveryLockout = false,
    int AutomaticRecoveryAttempts = 0);

public enum ActivationVerdict
{
    Allowed,
    Blocked
}

public record ActivationAssessment(ActivationVerdict Verdict, string PolicyCode, string Reason);

/// <summary>
/// Pure load-response rules ported from the dashboard scenario logic
/// (pre-activation assessment, selective shedding, idle shutdown).
/// Also executed on the ESP32; kept here so backend, firmware and
/// thesis evaluation share one deterministic definition.
/// </summary>
public static class LoadResponseEvaluator
{
    public static bool IsEnergized(OutletStatus status)
        => status is OutletStatus.Active or OutletStatus.Standby;

    public static double TotalLoad(IEnumerable<OutletLoadSnapshot> outlets)
        => outlets.Where(o => IsEnergized(o.Status)).Sum(o => o.Watts);

    public static SystemState GetSystemState(double totalWatts, double warningThreshold, double criticalThreshold)
    {
        if (totalWatts >= criticalThreshold)
        {
            return SystemState.Critical;
        }

        if (totalWatts >= warningThreshold)
        {
            return SystemState.Warning;
        }

        return SystemState.Normal;
    }

    // POL-02 pre-activation assessment / POL-03 pre-activation denial.
    public static ActivationAssessment AssessActivation(double currentTotalWatts, double requestedAllowanceWatts, double limitWatts, string outletName)
    {
        if (currentTotalWatts + requestedAllowanceWatts > limitWatts)
        {
            return new ActivationAssessment(
                ActivationVerdict.Blocked,
                "POL-03",
                $"{outletName} request denied: {currentTotalWatts:F0} W current load + {requestedAllowanceWatts:F0} W allowance exceeds P_limit {limitWatts:F0} W.");
        }

        return new ActivationAssessment(
            ActivationVerdict.Allowed,
            "POL-02",
            $"{outletName} passed pre-activation assessment; relay may close.");
    }

    // POL-05 load shedding level 1: lowest-tier energized outlets first.
    //
    // Ordering is delegated to LoadSheddingEngine.SelectNextShed so there is
    // exactly ONE shed-ordering rule in the codebase. It used to live here as
    // OrderBy(Priority).ThenBy(Watts) ascending - i.e. shed the SMALLEST load
    // first - which is backwards for the thesis: within one tier the biggest
    // draw relieves the most overload per relay operation, so the tie-break is
    // highest current first.
    public static IReadOnlyList<int> SelectSheddingCandidates(IEnumerable<OutletLoadSnapshot> outlets, int count)
        => LoadSheddingEngine.SelectNextShed(outlets, count).Select(o => o.Id).ToList();

    // POL-08 standby load management / idle shutdown: standby channels,
    // plus energized channels sitting at or below the standby threshold.
    public static IReadOnlyList<int> DetectIdleCandidates(IEnumerable<OutletLoadSnapshot> outlets, double standbyThresholdWatts)
        => outlets
            .Where(o => o.Status == OutletStatus.Standby
                || (IsEnergized(o.Status) && o.Watts <= standbyThresholdWatts))
            .Select(o => o.Id)
            .ToList();
}
