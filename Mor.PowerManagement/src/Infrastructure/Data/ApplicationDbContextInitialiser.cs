using Mor.PowerManagement.Domain.Constants;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.ValueObjects;
using Mor.PowerManagement.Infrastructure.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Text;

namespace Mor.PowerManagement.Infrastructure.Data;

public static class InitialiserExtensions
{
    public static async Task InitialiseDatabaseAsync(this WebApplication app)
    {
        using var scope = app.Services.CreateScope();

        var initialiser = scope.ServiceProvider.GetRequiredService<ApplicationDbContextInitialiser>();

        await initialiser.InitialiseAsync();
        await initialiser.SeedAsync();
    }
}

public class ApplicationDbContextInitialiser
{
    private readonly ILogger<ApplicationDbContextInitialiser> _logger;
    private readonly ApplicationDbContext _context;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly RoleManager<IdentityRole> _roleManager;

    public ApplicationDbContextInitialiser(ILogger<ApplicationDbContextInitialiser> logger, ApplicationDbContext context, UserManager<ApplicationUser> userManager, RoleManager<IdentityRole> roleManager)
    {
        _logger = logger;
        _context = context;
        _userManager = userManager;
        _roleManager = roleManager;
    }

    public async Task InitialiseAsync()
    {
        try
        {
            // Migrations-based initialisation (Neon-safe: never deletes the database).
            // See https://jasontaylor.dev/ef-core-database-initialisation-strategies
            await _context.Database.MigrateAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "An error occurred while initialising the database.");
            throw;
        }
    }

    public async Task SeedAsync()
    {
        try
        {
            await TrySeedAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "An error occurred while seeding the database.");
            throw;
        }
    }

    public async Task TrySeedAsync()
    {        // Default roles
        var administratorRole = new IdentityRole(Roles.Administrator);

        if (_roleManager.Roles.All(r => r.Name != administratorRole.Name))
        {
            await _roleManager.CreateAsync(administratorRole);
        }

        // Default users
        var administrator = new ApplicationUser { UserName = "administrator@localhost", Email = "administrator@localhost" };

        if (_userManager.Users.All(u => u.UserName != administrator.UserName))
        {
            await _userManager.CreateAsync(administrator, "Administrator1!");
            if (!string.IsNullOrWhiteSpace(administratorRole.Name))
            {
                await _userManager.AddToRolesAsync(administrator, new [] { administratorRole.Name });
            }
        }

        // Hardcoded demo account for the GUI (local defense demo).
        var demo = new ApplicationUser { UserName = "demo@localhost", Email = "demo@localhost" };

        if (_userManager.Users.All(u => u.UserName != demo.UserName))
        {
            await _userManager.CreateAsync(demo, "Demo1234!");
        }

        // A mistyped password during the demo must never lock the dashboard out:
        // disable lockout for the local accounts and clear any active lockout.
        foreach (var userName in new[] { administrator.UserName!, demo.UserName! })
        {
            var user = await _userManager.FindByNameAsync(userName);
            if (user is null)
            {
                continue;
            }

            await _userManager.SetLockoutEnabledAsync(user, false);
            await _userManager.ResetAccessFailedCountAsync(user);
            await _userManager.SetLockoutEndDateAsync(user, null);
        }

        // Default data
        // Seed, if necessary
        if (!_context.TodoLists.Any())
        {
            _context.TodoLists.Add(new TodoList
            {
                Title = "Tasks",
                Colour = Colour.Green,
                Items =
                {
                    new TodoItem { Title = "Make a todo list 📃" },
                    new TodoItem { Title = "Check off the first item ✅" },
                    new TodoItem { Title = "Realise you've already done two things on the list! 🤯"},
                    new TodoItem { Title = "Reward yourself with a nice, long nap 🏆" },
                }
            });

            await _context.SaveChangesAsync();
        }

        // -------------------------------------------------------------------
        // TESTING RIG — four 220V outlets, each measured by its own CT.
        // INA226 readings are separate DC telemetry and never become an outlet.
        // Set false to restore the full 13-channel rig for the final panel.
        // -------------------------------------------------------------------
        const bool TestingRig = true;

        // Seeded outlet load is 260 + 180 + 120 + 0 = 560 W, so a 4400 W P_limit leaves ~3840 W of headroom above
        // the seeded state and the rig boots healthy, while still reaching the
        // 3520 W warning threshold on one realistic added load.
        // Thresholds are 80% / 100% of capacity, matching the full-rig ratios.
        //
        // The live rig uses a 4400 W whole-system ceiling, with warning at 80%
        // (3520 W). Each outlet separately starts with an editable 300 W
        // allowance; changing a branch allowance does not change P_limit.
        //
        // WHAT THIS CHANGES ON THE BENCH, stated plainly: the seeded 567 W used
        // to sit at 47% of a 1200 W P_limit, i.e. the rig booted ALREADY inside
        // the warning band, and one ordinary added load tripped it. At 4400 W
        // the same seed sits at 13% and the rig boots comfortably below warning.
        //
        // Note this is now BELOW the full-rig 4000 W capacity below, which is
        // correct and intentional: this four-outlet bench panel is rated 4400 W by
        // the operator's own figures, and the full-rig numbers describe the
        // 13-channel final panel, which is a different machine.
        const double TestingMaxCapacityWatts = 4400.0;
        const double TestingWarningThresholdWatts = 3520.0;
        const double TestingCriticalThresholdWatts = 4400.0;

        const double FullRigMaxCapacityWatts = 4000.0;
        const double FullRigWarningThresholdWatts = 3240.0;
        const double FullRigCriticalThresholdWatts = 3600.0;

        var (maxCapacity, warning, critical) = TestingRig
            ? (TestingMaxCapacityWatts, TestingWarningThresholdWatts, TestingCriticalThresholdWatts)
            : (FullRigMaxCapacityWatts, FullRigWarningThresholdWatts, FullRigCriticalThresholdWatts);

        // CriticalThresholdWatts IS the whole-system operating limit P_limit the
        // priority-based load shedding framework runs on - the framework reads
        // the same column rather than a second threshold, so there is exactly
        // one P_limit in the system and an operator cannot set two that
        // disagree. On this four-outlet bench P_limit is 4400 W (the const
        // above), and the recovery limit the framework restores into is
        // 3960 W (4400 W less the 10% hysteresis band, LoadSheddingSettings).
        // Per-outlet allowances come from each outlet's independently editable
        // AllowanceWatts field; priority does not exempt a branch from its cap.

        var rigConfig = await _context.PowerSystemConfigs.FirstOrDefaultAsync();
        if (rigConfig is null)
        {
            _context.PowerSystemConfigs.Add(new PowerSystemConfig
            {
                MaxCapacityWatts = maxCapacity,
                WarningThresholdWatts = warning,
                CriticalThresholdWatts = critical,
                StandbyThresholdWatts = 80,
                StandbyIdleMinutes = 30,
                StabilizationDelayMs = 500,
                // Fresh install with no device history yet: the repo's bench
                // state is SIMULATE_METERS = 1, so seed Simulated. Existing rows
                // are left alone below — the device's own report is the only
                // other writer, and it must never be clobbered on boot (E19).
                MeteringMode = MeteringMode.Simulated,
                MeteringModeUpdatedAt = DateTimeOffset.UtcNow,
            });
        }
        else
        {
            rigConfig.MaxCapacityWatts = maxCapacity;
            rigConfig.WarningThresholdWatts = warning;
            rigConfig.CriticalThresholdWatts = critical;
            rigConfig.StandbyThresholdWatts = 80;
            rigConfig.StandbyIdleMinutes = 30;
            rigConfig.StabilizationDelayMs = 500;
        }

        // One row per channel: name, role, relay label, priority, allowance,
        // rail volts, schedule, idle limit, seeded status, seeded watts.
        // Priority maps onto the thesis load tiers 1:1 and INVERTED (see
        // Domain/Enums/LoadTier.cs): Critical(4)->Tier 1 Critical, High(3)->Tier 2
        // Important, Medium(2)->Tier 3 Deferrable, Low(1)->Tier 4 Nonessential.
        //
        // On this four-outlet rig the ladder the thesis demonstrates end to end is:
        //   CH1 Critical -> Tier 1 Critical    keep powered, still has a 300 W allowance
        //   CH2 High     -> Tier 2 Important   shed last of the expendable
        //   CH3 Medium   -> Tier 3 Deferrable  shed with CH4
        //   CH4 Medium   -> Tier 3 Deferrable  shed with CH3 (seeded down)
        var testingRigSpecs = new (string Name, string Role, string Relay, OutletPriority Priority, double Allowance, int Volts, string Schedule, int? Idle, OutletStatus Status, double Watts)[]
        {
            // 300 W is the editable default per-outlet allowance for this 4-channel rig.
            // Framework Admin can change each branch independently. Existing rows keep
            // their operator-edited allowance across application restarts.
            //
            // The seeded Watts (260 / 180 / 120 / 0) are DELIBERATELY UNCHANGED.
            // They are the rig's realistic start state and are not the limits; a
            // seeded value that was silently rescaled to match a new cap would be a
            // fabricated measurement, and the whole point of these rows is that they
            // represent a real (if small) load so the dashboard is not reading zeroes.
            // Every seeded CH1-3 figure is within its 300 W allowance
            // (87% / 60% / 40%), which is what a bench panel actually sitting idle
            // looks like.
            ("Outlet 1", "Instructor workstation", "Relay CH1", OutletPriority.Critical, 300, 220, "Class hours + override", null, OutletStatus.Active, 260),
            ("Outlet 2", "Demo equipment", "Relay CH2", OutletPriority.High, 300, 220, "08:00-18:00", 20, OutletStatus.Active, 180),
            ("Outlet 3", "Lab instrument", "Relay CH3", OutletPriority.Medium, 300, 220, "08:00-18:00", 20, OutletStatus.Active, 120),
            ("Outlet 4", "Student workstation", "Relay CH4", OutletPriority.Medium, 300, 220, "Class hours", 15, OutletStatus.Disconnected, 0),
        };

        // Full 13-channel rig (8x220V + 1x110V + 4xUSB, single mains PZEM).
        var fullRigSpecs = new (string Name, string Role, string Relay, OutletPriority Priority, double Allowance, int Volts, string Schedule, int? Idle, OutletStatus Status, double Watts)[]
        {
            ("Outlet 1", "Instructor workstation", "Relay CH1", OutletPriority.Critical, 500, 220, "Class hours + override", null, OutletStatus.Active, 430),
            ("Outlet 2", "Demo equipment", "Relay CH2", OutletPriority.High, 500, 220, "08:00-18:00", 20, OutletStatus.Active, 360),
            ("Outlet 3", "Lab instrument", "Relay CH3", OutletPriority.High, 500, 220, "08:00-18:00", 20, OutletStatus.Active, 280),
            ("Outlet 4", "Student workstation A", "Relay CH4", OutletPriority.Medium, 500, 220, "Class hours", 15, OutletStatus.Active, 210),
            ("Outlet 5", "Student workstation B", "Relay CH5", OutletPriority.Medium, 500, 220, "Class hours", 15, OutletStatus.Disconnected, 0),
            ("Outlet 6", "General-use device A", "Relay CH6", OutletPriority.Low, 500, 220, "Authorized window", 10, OutletStatus.Disconnected, 0),
            ("Outlet 7", "General-use device B", "Relay CH7", OutletPriority.Low, 500, 220, "Authorized window", 10, OutletStatus.Disconnected, 0),
            ("Outlet 8", "General-use device C", "Relay CH8", OutletPriority.Low, 500, 220, "Authorized window", 10, OutletStatus.Disconnected, 0),
            ("Outlet 9 (110V)", "110V instrument via step-down", "Relay CH9", OutletPriority.Medium, 300, 110, "Lab sessions", 15, OutletStatus.Disconnected, 0),
            ("USB 1", "USB charging 5V", "Relay CH10", OutletPriority.Low, 10, 5, "Class hours", null, OutletStatus.Standby, 7),
            ("USB 2", "USB charging 5V", "Relay CH11", OutletPriority.Low, 10, 5, "Class hours", null, OutletStatus.Disconnected, 0),
            ("USB 3", "USB charging 5V", "Relay CH12", OutletPriority.Low, 10, 5, "Class hours", null, OutletStatus.Disconnected, 0),
            ("USB 4", "USB charging 5V", "Relay CH13", OutletPriority.Low, 10, 5, "Class hours", null, OutletStatus.Disconnected, 0),
        };

        var outletSpecs = TestingRig ? testingRigSpecs : fullRigSpecs;

        // Idempotent rig sync: add missing channels and refresh hardware identity
        // on existing ones, while preserving operator-edited outlet allowances.
        foreach (var spec in outletSpecs)
        {
            var outlet = await _context.Outlets.FirstOrDefaultAsync(o => o.Name == spec.Name);
            if (outlet is null)
            {
                _context.Outlets.Add(new Outlet
                {
                    Name = spec.Name,
                    Role = spec.Role,
                    MeterChannel = "PZEM-01 · mains bus",
                    RelayChannel = spec.Relay,
                    Priority = spec.Priority,
                    AllowanceWatts = spec.Allowance,
                    RatedVoltageVolts = spec.Volts,
                    Schedule = spec.Schedule,
                    IdleLimitMinutes = spec.Idle,
                    Status = spec.Status,
                    CurrentWatts = spec.Watts,
                });
            }
            else
            {
                outlet.Role = spec.Role;
                outlet.MeterChannel = "PZEM-01 · mains bus";
                outlet.RelayChannel = spec.Relay;
                outlet.Priority = spec.Priority;
                outlet.RatedVoltageVolts = spec.Volts;
                outlet.Schedule = spec.Schedule;
                outlet.IdleLimitMinutes = spec.Idle;
            }
        }

        if (TestingRig)
        {
            // This board has four physical outlets, addressed as outletId 1..4.
            // Keep those rows and their telemetry intact, remove stale channels
            // above four, then align the four policy rows by id. INA226 data is
            // carried separately and is not an outlet.
            var existing = await _context.Outlets.OrderBy(o => o.Id).ToListAsync();
            var matches = existing.Count == testingRigSpecs.Length
                && testingRigSpecs.Select((spec, i) =>
                        existing[i].RelayChannel == spec.Relay && existing[i].Id == i + 1 && existing[i].Name == spec.Name)
                    .All(matched => matched);

            if (!matches)
            {
                var stale = existing.Where(outlet => outlet.Id > testingRigSpecs.Length || outlet.Id < 1).ToList();
                _context.Outlets.RemoveRange(stale);
                await _context.SaveChangesAsync();

                for (var i = 0; i < testingRigSpecs.Length; i++)
                {
                    var spec = testingRigSpecs[i];
                    var outlet = await _context.Outlets.FirstOrDefaultAsync(o => o.Id == i + 1);
                    if (outlet is null)
                    {
                        outlet = new Outlet
                        {
                            Id = i + 1,
                            Status = spec.Status,
                            CurrentWatts = spec.Watts,
                            AllowanceWatts = spec.Allowance,
                        };
                        _context.Outlets.Add(outlet);
                    }

                    outlet.Name = spec.Name;
                    outlet.Role = spec.Role;
                    outlet.MeterChannel = "PZEM-01 · mains bus";
                    outlet.RelayChannel = spec.Relay;
                    outlet.Priority = spec.Priority;
                    outlet.RatedVoltageVolts = spec.Volts;
                    outlet.Schedule = spec.Schedule;
                    outlet.IdleLimitMinutes = spec.Idle;
                }

                await _context.SaveChangesAsync();

                // Rewind identity after removing old rig channels.
                await _context.Database.ExecuteSqlRawAsync(
                    "SELECT setval(pg_get_serial_sequence('\"Outlets\"', 'Id'), (SELECT COALESCE(MAX(\"Id\"), 0) FROM \"Outlets\"), true);");

                _logger.LogInformation(
                    "Four-outlet rig active: removed {Count} stale outlet rows above channel 4.", stale.Count);
            }
        }

        // Framework rules FR-01..FR-12 (see MUST_READ.md section 3).
        // Seeded idempotently: codes are the key, so renaming a rule updates it
        // instead of duplicating. POL-xx survives in LegacyCode.
        var ruleSpecs = new (string Code, string Name, string Condition, string Action, string Family, string? Legacy, int Precedence)[]
        {
            ("FR-01", "Hardware Fault Isolation", "S_fault is TRUE for 3 consecutive ticks", "ACT_FAULT()", "Safety/Interlock", "POL-01", 10),
            ("FR-02", "Voltage Window Protection", "Branch voltage outside 198-264 V (220 V class) for 2 consecutive ticks", "ACT_SHED(i) + latch", "Safety/Interlock", null, 20),
            ("FR-03", "Branch Overcurrent Protection", "I_branch exceeds 1.25 x rated amps for 2 consecutive ticks", "ACT_SHED(i) + latch", "Safety/Interlock", null, 30),
            ("FR-04", "Pre-Activation Assessment", "Request(i) and P_total + Allowance(i) is at or below P_limit", "ACT_ALLOW(i)", "PreActivation", "POL-02", 40),
            ("FR-05", "Pre-Activation Denial", "Request(i) and P_total + Allowance(i) exceeds P_limit, or branch is latched", "ACT_DENY(i)", "PreActivation", "POL-03", 50),
            ("FR-06", "Post-Activation Verification", "500 ms after activation and P_total exceeds P_limit", "ACT_SHED(i) - newest activation first", "PostActivation", "POL-04", 60),
            ("FR-07", "Load Shedding Level 1", "P_total exceeds P_limit for low-priority energized outlets", "ACT_SHED(i)", "DemandSide", "POL-05", 70),
            ("FR-08", "Load Shedding Level 2", "Overload remains after low-priority shedding", "ACT_SHED(i) for medium priority", "DemandSide", "POL-06", 80),
            ("FR-09", "Priority Preservation", "High or Critical outlet is active during shedding", "ACT_PRESERVE(i)", "DemandSide", "POL-07", 90),
            ("FR-10", "Standby Load Management", "P_branch_i stays below 80 W standby threshold for 30 minutes", "ACT_SHED(i)", "Idle", "POL-08", 100),
            ("FR-11", "Calibration Due Downgrade", "CalibrationDueAt is in the past for the branch instrument class", "ACT_DOWNGRADE(i)", "Measurement", null, 110),
            ("FR-12", "Rule Audit Trail", "Any rule fires", "ACT_LOG()", "Audit", null, 120),
        };

        foreach (var spec in ruleSpecs)
        {
            var rule = await _context.ControlPolicies.FirstOrDefaultAsync(p => p.Code == spec.Code);
            if (rule is null)
            {
                _context.ControlPolicies.Add(new ControlPolicy
                {
                    Code = spec.Code,
                    Name = spec.Name,
                    Condition = spec.Condition,
                    Action = spec.Action,
                    RuleFamily = spec.Family,
                    LegacyCode = spec.Legacy,
                    Precedence = spec.Precedence,
                    Enabled = true,
                });
            }
            else
            {
                rule.Name = spec.Name;
                rule.Condition = spec.Condition;
                rule.Action = spec.Action;
                rule.RuleFamily = spec.Family;
                rule.LegacyCode = spec.Legacy;
                rule.Precedence = spec.Precedence;
                rule.Enabled = true;
            }
        }

        // Retire any legacy POL-xx row that survived an earlier seed: FR-xx
        // carries the same meaning and LegacyCode keeps the manuscript usable.
        var legacyRows = await _context.ControlPolicies
            .Where(p => p.Code.StartsWith("POL-"))
            .ToListAsync();
        if (legacyRows.Count > 0)
        {
            _context.ControlPolicies.RemoveRange(legacyRows);
        }

        if (!_context.PowerEvents.Any())
        {
            _context.PowerEvents.AddRange(
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Dashboard synchronized", Detail = "Framework rules FR-01..FR-12 loaded for the four-outlet testing rig: four 220V outlets, each metered by a branch CT, with editable 300 W per-outlet allowances. INA226 is separate DC rail telemetry. P_limit is 4400 W.", Severity = EventSeverity.Info },
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Normal operating state", Detail = "Total load is below the 3520 W warning threshold.", Severity = EventSeverity.Success },
                new PowerEvent
                {
                    Timestamp = DateTimeOffset.UtcNow,
                    Title = "Priority-based load shedding armed",
                    Detail = "Load tiers active on this rig: CH1 Critical (tier 1), CH2 Important (tier 2), CH3 and CH4 Deferrable (tier 3). Each outlet has its own editable 300 W allowance. " +
                        "P_limit 4400 W; overload must persist 3 consecutive batches before anything is shed. " +
                        "Restoration resumes only below the 3960 W recovery limit (4400 W less the 10% hysteresis band) held for 30 s, one branch at a time with a 5 s reconnect stagger. " +
                        "Tier 1 is never shed automatically; an overload that survives every eligible shed raises an alarm instead of being assumed safe. " +
                        "This is prototype software control, not a substitute for fuses and breakers.",
                    Severity = EventSeverity.Info,
                });
        }

        await _context.SaveChangesAsync();
    }
}
