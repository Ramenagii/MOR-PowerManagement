namespace Mor.PowerManagement.Domain.Constants;

// Tuning constants for the priority-based load shedding and staged restoration
// framework.
//
// EVERY DURATION HERE IS SITE-TESTED, NOT UNIVERSAL. They are compile-time
// constants on purpose: they are the framework's documented defaults, they are
// what the thesis evaluates against, and making them runtime-editable before the
// rig has produced evidence for the right values would only invite a setting
// nobody can justify. Each constant below states the assumption behind its
// value so a future site test can falsify it deliberately rather than by feel.
//
// This is a SOFTWARE PROTOTYPE for thesis evaluation. It is layered on top of,
// and is never a substitute for, the rig's fuses, breakers and RCD/GFCI. Those
// are the only devices that interrupt a fault the moment it appears; anything
// this framework fails to shed stays energised.
public abstract class LoadSheddingSettings
{
    // Channel 5 is the INA226 USB/DC monitor on this bench. Its watts are not
    // part of the mains total and it has no relay to shed or restore.
    public const int MonitoredOnlyOutletId = 5;

    // ---- Load-shedding confirmation -------------------------------------
    // How long fresh telemetry must keep P_total above P_limit before anything
    // is shed. The ESP32 reports at 1 Hz, so detection is quantized to roughly
    // one second plus relay-command delivery time.
    //
    // Three seconds filters a transient while keeping the relay response short.
    public const int OverLimitConfirmationSeconds = 3;

    // A longer gap means the samples cannot establish continuous overload.
    // Reset the timer instead of treating missing telemetry as sustained load.
    public const int MaxOverLimitSampleGapSeconds = 2;

    // A recovery trial still uses a small number of fresh batches to verify
    // that reconnecting the outlet did not push the rig back over its limit.
    public const int RecoveryTrialConfirmationBatches = 3;

    // Per-outlet protection reacts on the first fresh reading at or above
    // that outlet's admin-configured allowance, independent of its priority.
    public const int OutletAllowanceConfirmationBatches = 1;

    // ---- Recovery hysteresis --------------------------------------------
    // Fraction of P_limit subtracted to get the restoration limit.
    //
    // Why 10%: a rig sitting exactly at P_limit after the last shed has no
    // margin, so the first restored outlet tips it straight back over and the
    // rig oscillates between shedding and restoring forever ("flapping"). The
    // band is dead space by design: P_total must fall clear of P_limit by a
    // margin that is wider than the restored load, before any outlet is
    // reconnected. At the 600 W bench rig this is a 60 W band.
    public const double RecoveryHysteresisFraction = 0.10;

    // How long P_total must stay below the recovery limit before the first
    // outlet is restored.
    //
    // Why 30 s: load that has genuinely been shed tends not to come back on
    // its own within half a minute, whereas load that is about to return
    // (someone walks back into the lab) usually returns faster than that.
    // Waiting out the window is what makes restoration staged rather than
    // immediately undoing the shed. Site-test: a lab with intermittent
    // large motor loads needs a longer window than a quiet one.
    // User-selected automatic recovery window: remain OFF for under one minute.
    public const int RecoveryPeriodSeconds = 55;

    // ---- Staged restoration ----------------------------------------------
    // Pause between reclosing one outlet and remeasuring the rig.
    //
    // Why 5 s: this is a RECONNECT STAGGER, not a safety delay. Reclosing
    // several outlets at once would re-create the inrush that triggered the
    // shed, and the rig would flap back into shedding without ever revealing
    // which outlet caused it. One reconnect, one remeasurement, one decision.
    // The rig's own telemetry cadence sets the floor for how fast this can
    // meaningfully be: below one scan period the remeasurement it waits for
    // has not happened yet.
    public const int InterReconnectDelaySeconds = 5;

    // F3 command feedback deadline. Device relay-state telemetry is logical
    // feedback; it does not prove contact voltage or isolation.
    public const int SwitchingResponseTimeoutSeconds = 5;

    // ---- Per-outlet allowance --------------------------------------------
    // Every outlet, including Critical, has an independently editable allowance.
    // Priority controls shed order; it does not bypass that outlet's allowance.
    public const bool CriticalTierIsCapExempt = false;

    // ---- Fault handling ---------------------------------------------------
    // A branch that reports no fresh reading is treated as UNKNOWN rather than
    // as zero, because zero is the one number that looks safe.
    //
    // Why 30 s: the rig posts every ~5 s, so 30 s is ~6 missed batches -
    // comfortably past one dropped post without tripping on a single hiccup.
    public const int SensorStalenessSeconds = 30;

    // Bound on how much of the rig a single non-exempt outlet may be responsible
    // for before the framework calls the reading implausible. Site-test: this
    // is a plausibility bound on a branch CT, NOT a protective device rating.
    public const double MaxPlausibleBranchWatts = 5000.0;
}
