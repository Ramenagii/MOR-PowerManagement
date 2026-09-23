using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Domain.Services;

public record OutletLoadSnapshot(int Id, OutletPriority Priority, OutletStatus Status, double Watts, double AllowanceWatts);

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
        => outlets.Sum(o => o.Watts);

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

    // POL-05 load shedding level 1: lowest-priority energized outlets first.
    public static IReadOnlyList<int> SelectSheddingCandidates(IEnumerable<OutletLoadSnapshot> outlets, int count)
        => outlets
            .Where(o => IsEnergized(o.Status))
            .OrderBy(o => o.Priority)
            .ThenBy(o => o.Watts)
            .Take(count)
            .Select(o => o.Id)
            .ToList();

    // POL-08 standby load management / idle shutdown: standby channels,
    // plus energized channels sitting at or below the standby threshold.
    public static IReadOnlyList<int> DetectIdleCandidates(IEnumerable<OutletLoadSnapshot> outlets, double standbyThresholdWatts)
        => outlets
            .Where(o => o.Status == OutletStatus.Standby
                || (IsEnergized(o.Status) && o.Watts <= standbyThresholdWatts))
            .Select(o => o.Id)
            .ToList();
}
