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
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
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
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;

    public ApplicationDbContextInitialiser(
        ILogger<ApplicationDbContextInitialiser> logger,
        ApplicationDbContext context,
        UserManager<ApplicationUser> userManager,
        RoleManager<IdentityRole> roleManager,
        IConfiguration configuration,
        IHostEnvironment environment)
    {
        _logger = logger;
        _context = context;
        _userManager = userManager;
        _roleManager = roleManager;
        _configuration = configuration;
        _environment = environment;
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
            var roleResult = await _roleManager.CreateAsync(administratorRole);
            ThrowIfFailed(roleResult, "Creating the administrator role");
        }

        var administrator = await EnsureAdministratorAsync(administratorRole);

        if (_environment.IsProduction())
        {
            var lockoutResult = await _userManager.SetLockoutEnabledAsync(administrator, true);
            ThrowIfFailed(lockoutResult, "Enabling administrator lockout protection");

            // Old deployments seeded this predictable demo user. Remove it on
            // startup so its demo password cannot remain a production login.
            if (await _userManager.FindByNameAsync("demo@localhost") is { } demoAccount)
            {
                var deleteResult = await _userManager.DeleteAsync(demoAccount);
                ThrowIfFailed(deleteResult, "Removing the development-only demo account from production");
            }
        }
        else
        {
            var demo = new ApplicationUser { UserName = "demo@localhost", Email = "demo@localhost" };
            if (await _userManager.FindByNameAsync(demo.UserName) is null
                && !string.IsNullOrWhiteSpace(_configuration["Admin:DevelopmentDemoPassword"]))
            {
                var result = await _userManager.CreateAsync(demo, _configuration["Admin:DevelopmentDemoPassword"]!);
                ThrowIfFailed(result, "Creating the development-only demo account");
            }

            // Disable lockout only for local demo convenience.
            foreach (var userName in new[] { administrator.UserName!, demo.UserName! })
            {
                var user = await _userManager.FindByNameAsync(userName);
                if (user is not null)
                {
                    await _userManager.SetLockoutEnabledAsync(user, false);
                    await _userManager.ResetAccessFailedCountAsync(user);
                    await _userManager.SetLockoutEndDateAsync(user, null);
                }
            }
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
        // TESTING RIG — four 220V CT outlets plus one monitored USB/DC outlet
        // whose live reading comes from the INA226 (no relay or CT).
        // Set false to restore the full 13-channel rig for the final panel.
        // -------------------------------------------------------------------
        var isTestingRig = true;

        // The four-branch + USB rig starts with a 1300 W system limit and an 80%
        // warning threshold. Framework Admin can revise these values.
        const double TestingMaxCapacityWatts = 1300.0;
        const double TestingWarningThresholdWatts = 1040.0;
        const double TestingCriticalThresholdWatts = 1300.0;

        const double FullRigMaxCapacityWatts = 4000.0;
        const double FullRigWarningThresholdWatts = 3240.0;
        const double FullRigCriticalThresholdWatts = 3600.0;

        var (maxCapacity, warning, critical) = isTestingRig
            ? (TestingMaxCapacityWatts, TestingWarningThresholdWatts, TestingCriticalThresholdWatts)
            : (FullRigMaxCapacityWatts, FullRigWarningThresholdWatts, FullRigCriticalThresholdWatts);

        // CriticalThresholdWatts IS the whole-system operating limit P_limit the
        // priority-based load shedding framework runs on - the framework reads
        // the same column rather than a second threshold, so there is exactly
        // one P_limit in the system and an operator cannot set two that
        // disagree. On this four-outlet bench P_limit starts at 1300 W (the
        // const above), and the recovery limit starts at 1170 W (1300 W less
        // the 10% hysteresis band, LoadSheddingSettings).
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
        // Existing Framework Admin threshold settings are preserved on startup.

        // One row per channel: name, role, relay label, priority, allowance,
        // rail volts, schedule, idle limit, seeded status, seeded watts.
        // Priority maps onto the thesis load tiers 1:1 and INVERTED (see
        // Domain/Enums/LoadTier.cs): Critical(4)->Tier 1 Critical, High(3)->Tier 2
        // Important, Medium(2)->Tier 3 Deferrable, Low(1)->Tier 4 Nonessential.
        //
        // On this four-branch rig the relay ladder is:
        //   CH1 Critical -> Tier 1 Critical    keep powered, still has a 300 W allowance
        //   CH2 High     -> Tier 2 Important   shed last of the expendable
        //   CH3 Medium   -> Tier 3 Deferrable  shed with CH4
        //   CH4 Medium   -> Tier 3 Deferrable  shed with CH3 (seeded down)
        //   CH5 USB      -> monitored by INA226, never switched by a relay
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
            ("Outlet 1", "Instructor workstation", "Relay CH1", OutletPriority.Critical, 300, 228, "Class hours + override", null, OutletStatus.Active, 260),
            ("Outlet 2", "Demo equipment", "Relay CH2", OutletPriority.High, 300, 228, "08:00-18:00", 20, OutletStatus.Active, 180),
            ("Outlet 3", "Lab instrument", "Relay CH3", OutletPriority.Medium, 300, 228, "08:00-18:00", 20, OutletStatus.Active, 120),
            ("Outlet 4", "Student workstation", "Relay CH4", OutletPriority.Medium, 300, 228, "Class hours", 15, OutletStatus.Disconnected, 0),
            ("USB 1", "USB rail monitored by INA226", "INA226 monitor", OutletPriority.Low, 10, 5, "Monitored only", null, OutletStatus.Standby, 0),
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

        var outletSpecs = isTestingRig ? testingRigSpecs : fullRigSpecs;

        // The full production rig keeps its name-keyed seeding path. The testing
        // rig is synchronized by fixed IDs below so stale full-rig rows cannot
        // survive and a pending USB insert cannot be counted twice.
        if (!isTestingRig)
        {
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
        }

        if (isTestingRig)
        {
            // This board has four physical relay/CT branches plus monitored USB
            // at outletId 5. Keep this exact five-row roster and remove stale
            // full-rig channels above it. The USB row has no relay or CT.
            var existing = await _context.Outlets.OrderBy(o => o.Id).ToListAsync();
            var stale = existing.Where(outlet => outlet.Id > testingRigSpecs.Length || outlet.Id < 1).ToList();
            if (stale.Count > 0)
            {
                _context.Outlets.RemoveRange(stale);
                await _context.SaveChangesAsync();
            }

            for (var i = 0; i < testingRigSpecs.Length; i++)
            {
                var spec = testingRigSpecs[i];
                var outlet = await _context.Outlets.FirstOrDefaultAsync(o => o.Id == i + 1);
                var isNew = outlet is null;
                outlet ??= new Outlet
                {
                    Id = i + 1,
                    AllowanceWatts = spec.Allowance,
                    Status = spec.Status,
                    CurrentWatts = spec.Watts,
                    IsProtected = spec.Relay == "INA226 monitor",
                };

                var identityChanged = !isNew &&
                    (outlet.Name != spec.Name || outlet.RelayChannel != spec.Relay);
                if (identityChanged)
                {
                    // Outlet 5 used to be a mains branch in the larger rig. Drop
                    // its old branch history before reusing that ID for USB, so
                    // the chart cannot label AC data as INA226 data.
                    if (spec.Relay == "INA226 monitor")
                    {
                        var oldReadings = await _context.TelemetryReadings
                            .Where(reading => reading.OutletId == outlet.Id)
                            .ToListAsync();
                        _context.TelemetryReadings.RemoveRange(oldReadings);
                    }
                    outlet.AllowanceWatts = spec.Allowance;
                    outlet.Status = spec.Status;
                    outlet.CurrentWatts = spec.Watts;
                    outlet.LastSeen = null;
                }

                if (isNew) _context.Outlets.Add(outlet);
                outlet.Name = spec.Name;
                outlet.Role = spec.Role;
                outlet.MeterChannel = spec.Relay == "INA226 monitor"
                    ? "INA226 — USB rail"
                    : "ADS1220 — branch CT";
                outlet.RelayChannel = spec.Relay;
                outlet.Priority = spec.Priority;
                outlet.RatedVoltageVolts = spec.Volts;
                outlet.Schedule = spec.Schedule;
                outlet.IdleLimitMinutes = spec.Idle;
                if (spec.Relay == "INA226 monitor") outlet.IsProtected = true;
            }

            await _context.SaveChangesAsync();

            // Rewind identity after removing old rig channels and adding any
            // missing rows with their fixed bench IDs.
            await _context.Database.ExecuteSqlRawAsync(
                "SELECT setval(pg_get_serial_sequence('\"Outlets\"', 'Id'), (SELECT COALESCE(MAX(\"Id\"), 0) FROM \"Outlets\"), true);");

            _logger.LogInformation(
                "Four-outlet + USB rig active: removed {Count} stale outlet rows above channel 5.", stale.Count);
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
            ("FR-06", "Post-Activation Verification", "500 ms after activation and P_total is at or above P_limit", "ACT_SHED(i) - newest activation first", "PostActivation", "POL-04", 60),
            ("FR-07", "Load Shedding Level 1", "P_total is at or above P_limit for low-priority energized outlets", "ACT_SHED(i)", "DemandSide", "POL-05", 70),
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
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Dashboard synchronized", Detail = "Framework rules loaded for the four-outlet + USB testing rig: four 220V CT outlets with editable 300 W allowances and one monitored USB/DC rail measured by the INA226. P_limit is 1300 W.", Severity = EventSeverity.Info },
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Normal operating state", Detail = "Total load is below the 1040 W warning threshold.", Severity = EventSeverity.Success },
                new PowerEvent
                {
                    Timestamp = DateTimeOffset.UtcNow,
                    Title = "Priority-based load shedding armed",
                    Detail = "Load tiers active on this rig: CH1 Critical (tier 1), CH2 Important (tier 2), CH3 and CH4 Deferrable (tier 3). Each outlet has its own editable 300 W allowance. " +
                        "P_limit 1300 W; overload must persist 3 consecutive batches before anything is shed. " +
                        "Restoration resumes only below the 1170 W recovery limit (1300 W less the 10% hysteresis band) held for 30 s, one branch at a time with a 5 s reconnect stagger. " +
                        "Tier 1 is never shed automatically; an overload that survives every eligible shed raises an alarm instead of being assumed safe. " +
                        "This is prototype software control, not a substitute for fuses and breakers.",
                    Severity = EventSeverity.Info,
                });
        }

        await _context.SaveChangesAsync();
    }

    private async Task<ApplicationUser> EnsureAdministratorAsync(IdentityRole administratorRole)
    {
        const string administratorName = "administrator@localhost";
        const string retiredDefaultPassword = "Administrator1!";
        var administrator = await _userManager.FindByNameAsync(administratorName);
        var initialPassword = _configuration["Admin:InitialPassword"];
        var resetExistingPassword = _configuration.GetValue<bool>("Admin:ResetExistingPassword");

        if (administrator is null)
        {
            initialPassword = RequireInitialPassword(initialPassword);
            administrator = new ApplicationUser { UserName = administratorName, Email = administratorName };
            var createResult = await _userManager.CreateAsync(administrator, initialPassword);
            ThrowIfFailed(createResult, "Creating the initial administrator account");
        }
        else if (resetExistingPassword)
        {
            initialPassword = RequireInitialPassword(initialPassword);
            var resetToken = await _userManager.GeneratePasswordResetTokenAsync(administrator);
            var resetResult = await _userManager.ResetPasswordAsync(administrator, resetToken, initialPassword);
            ThrowIfFailed(resetResult, "Resetting the existing administrator password");
            _logger.LogWarning(
                "The existing administrator password was reset from Admin:InitialPassword. Remove Admin:ResetExistingPassword from the hosting environment now.");
        }
        else if (_environment.IsProduction() && await _userManager.CheckPasswordAsync(administrator, retiredDefaultPassword))
        {
            // Existing Neon databases may already contain the former demo
            // credential. Replace it once using the hosting secret.
            initialPassword = RequireInitialPassword(initialPassword);
            var changeResult = await _userManager.ChangePasswordAsync(administrator, retiredDefaultPassword, initialPassword);
            ThrowIfFailed(changeResult, "Rotating the former default administrator password");
        }

        if (!string.IsNullOrWhiteSpace(administratorRole.Name)
            && !await _userManager.IsInRoleAsync(administrator, administratorRole.Name))
        {
            var roleResult = await _userManager.AddToRoleAsync(administrator, administratorRole.Name);
            ThrowIfFailed(roleResult, "Assigning the administrator role");
        }

        return administrator;
    }

    private static string RequireInitialPassword(string? password)
    {
        if (string.IsNullOrWhiteSpace(password) || password.Length < 16)
        {
            throw new InvalidOperationException(
                "Set Admin__InitialPassword to a unique password with at least 16 characters before the first production startup (or while rotating the former default password).");
        }

        return password;
    }

    private static void ThrowIfFailed(IdentityResult result, string operation)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException($"{operation} failed: {string.Join("; ", result.Errors.Select(error => error.Description))}");
        }
    }
}
