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
        // TESTING RIG (temporary until 31 Oct 2026) — see MUST_READ.md.
        // 5 channels: 4x220V outlets (CH1-CH4) + 1xUSB 5V (CH5).
        // The USB rail counts toward P_total and is a shed candidate.
        // Set false to restore the full 13-channel rig for the final panel.
        // -------------------------------------------------------------------
        const bool TestingRig = true;

        const double TestingMaxCapacityWatts = 1200.0;
        const double TestingWarningThresholdWatts = 960.0;
        const double TestingCriticalThresholdWatts = 1200.0;

        const double FullRigMaxCapacityWatts = 4000.0;
        const double FullRigWarningThresholdWatts = 3240.0;
        const double FullRigCriticalThresholdWatts = 3600.0;

        var (maxCapacity, warning, critical) = TestingRig
            ? (TestingMaxCapacityWatts, TestingWarningThresholdWatts, TestingCriticalThresholdWatts)
            : (FullRigMaxCapacityWatts, FullRigWarningThresholdWatts, FullRigCriticalThresholdWatts);

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
        var testingRigSpecs = new (string Name, string Role, string Relay, OutletPriority Priority, double Allowance, int Volts, string Schedule, int? Idle, OutletStatus Status, double Watts)[]
        {
            ("Outlet 1", "Instructor workstation", "Relay CH1", OutletPriority.Critical, 300, 220, "Class hours + override", null, OutletStatus.Active, 260),
            ("Outlet 2", "Demo equipment", "Relay CH2", OutletPriority.High, 300, 220, "08:00-18:00", 20, OutletStatus.Active, 180),
            ("Outlet 3", "Lab instrument", "Relay CH3", OutletPriority.High, 300, 220, "08:00-18:00", 20, OutletStatus.Active, 120),
            ("Outlet 4", "Student workstation", "Relay CH4", OutletPriority.Medium, 300, 220, "Class hours", 15, OutletStatus.Disconnected, 0),
            // Testing rig has a single USB 5V rail; it counts toward P_total.
            ("USB 1", "USB charging 5V", "Relay CH5", OutletPriority.Low, 10, 5, "Class hours", null, OutletStatus.Standby, 7),
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

        // Idempotent rig sync: add missing channels, refresh policy fields on
        // existing ones, never touch live status/readings.
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
                outlet.AllowanceWatts = spec.Allowance;
                outlet.RatedVoltageVolts = spec.Volts;
                outlet.Schedule = spec.Schedule;
                outlet.IdleLimitMinutes = spec.Idle;
            }
        }

        if (TestingRig)
        {
            // The bench physically has five channels, and the firmware addresses
            // them positionally: outletId 1..5 in every telemetry batch. The
            // full-rig seed left USB 1 at id 10, which no bench channel could
            // ever match, so the testing rig takes the table over wholesale:
            // delete every outlet row (telemetry cascades) and re-seed in spec
            // order, which renumbers the channels 1..5.
            //
            // The reset is one-shot: it only runs while the stored rows do not
            // already match the testing spec exactly (same rows, same order,
            // ids 1..5). A restart after a live bench session must never wipe
            // the device's live status, load or telemetry history.
            // Restored by flipping TestingRig back to false.
            var existing = await _context.Outlets.OrderBy(o => o.Id).ToListAsync();
            var matches = existing.Count == testingRigSpecs.Length
                && testingRigSpecs.Select((spec, i) =>
                        existing[i].RelayChannel == spec.Relay && existing[i].Id == i + 1)
                    .All(matched => matched);

            if (!matches)
            {
                _context.Outlets.RemoveRange(existing);

                foreach (var spec in testingRigSpecs)
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

                await _context.SaveChangesAsync();

                // Postgres identity sequences do not rewind, so the fresh rows
                // come back numbered after the deleted ones. The firmware sends
                // outletId 1..5 positionally, so Id must equal channel number or
                // Guard.Against.NotFound silently drops every reading. Telemetry
                // cascaded away with the old rows, so nothing references the old
                // ids and the renumbering is safe. Raw SQL because EF does not
                // expose identity reseeding.
                var renumber = new StringBuilder("UPDATE \"Outlets\" SET \"Id\" = CASE \"RelayChannel\" ");
                for (var i = 0; i < testingRigSpecs.Length; i++)
                {
                    renumber.Append("WHEN '").Append(testingRigSpecs[i].Relay).Append("' THEN ").Append(i + 1).Append(' ');
                }

                renumber.Append("END WHERE \"RelayChannel\" IN (");
                renumber.Append(string.Join(", ", testingRigSpecs.Select(s => $"'{s.Relay}'")));
                renumber.Append(");");

                await _context.Database.ExecuteSqlRawAsync(renumber.ToString());
                await _context.Database.ExecuteSqlRawAsync(
                    "SELECT setval(pg_get_serial_sequence('\"Outlets\"', 'Id'), (SELECT COALESCE(MAX(\"Id\"), 0) FROM \"Outlets\"), true);");

                _logger.LogInformation(
                    "Testing rig active: reset {Count} outlet rows so channels renumber 1-5.", existing.Count);
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
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Dashboard synchronized", Detail = "Framework rules FR-01..FR-12 loaded for the testing rig: 4x220V outlets (CH1-CH4) plus 1xUSB 5V (CH5) on a single mains feed. USB counts toward P_total; P_limit is capped at 1200 W until 31 Oct 2026.", Severity = EventSeverity.Info },
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Normal operating state", Detail = "Total load is below the 960 W warning threshold.", Severity = EventSeverity.Success });
        }

        await _context.SaveChangesAsync();
    }
}
