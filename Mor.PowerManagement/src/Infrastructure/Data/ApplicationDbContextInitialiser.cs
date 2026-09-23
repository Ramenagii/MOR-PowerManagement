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
    {
        // Default roles
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

        // 13-channel rig spec (8x220V + 1x110V + 4xUSB, single mains PZEM).
        // Enforced on every start so firmware, dashboard and thesis evaluation
        // share one deterministic configuration.
        var rigConfig = await _context.PowerSystemConfigs.FirstOrDefaultAsync();
        if (rigConfig is null)
        {
            _context.PowerSystemConfigs.Add(new PowerSystemConfig
            {
                MaxCapacityWatts = 4000,
                WarningThresholdWatts = 3240,
                CriticalThresholdWatts = 3600,
                StandbyThresholdWatts = 80,
                StandbyIdleMinutes = 30,
                StabilizationDelayMs = 500,
            });
        }
        else
        {
            rigConfig.MaxCapacityWatts = 4000;
            rigConfig.WarningThresholdWatts = 3240;
            rigConfig.CriticalThresholdWatts = 3600;
            rigConfig.StandbyThresholdWatts = 80;
            rigConfig.StandbyIdleMinutes = 30;
            rigConfig.StabilizationDelayMs = 500;
        }

        var outletSpecs = new (string Name, string Role, string Relay, OutletPriority Priority, double Allowance, int Volts, string Schedule, int? Idle, OutletStatus Status, double Watts)[]
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
            ("USB 1", "USB charging 5V", "Relay CH10", OutletPriority.Low, 25, 5, "Class hours", null, OutletStatus.Standby, 12),
            ("USB 2", "USB charging 5V", "Relay CH11", OutletPriority.Low, 25, 5, "Class hours", null, OutletStatus.Disconnected, 0),
            ("USB 3", "USB charging 5V", "Relay CH12", OutletPriority.Low, 25, 5, "Class hours", null, OutletStatus.Disconnected, 0),
            ("USB 4", "USB charging 5V", "Relay CH13", OutletPriority.Low, 25, 5, "Class hours", null, OutletStatus.Disconnected, 0),
        };

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

        if (!_context.ControlPolicies.Any())
        {
            _context.ControlPolicies.AddRange(
                new ControlPolicy { Code = "POL-01", Name = "Hardware Fault Isolation", Condition = "S_fault is TRUE", Action = "ACT_FAULT()" },
                new ControlPolicy { Code = "POL-02", Name = "Pre-Activation Assessment", Condition = "Request(i) and P_total is below P_limit", Action = "ACT_ALLOW(i)" },
                new ControlPolicy { Code = "POL-03", Name = "Pre-Activation Denial", Condition = "Request(i) and P_total is at or above P_limit", Action = "ACT_DENY(i)" },
                new ControlPolicy { Code = "POL-04", Name = "Post-Activation Verification", Condition = "500 ms after activation and P_total exceeds P_limit", Action = "ACT_SHED(i)" },
                new ControlPolicy { Code = "POL-05", Name = "Load Shedding Level 1", Condition = "P_total exceeds P_limit for low-priority energized outlets", Action = "ACT_SHED(i)" },
                new ControlPolicy { Code = "POL-06", Name = "Load Shedding Level 2", Condition = "Overload remains after low-priority shedding", Action = "ACT_SHED(i) for medium priority" },
                new ControlPolicy { Code = "POL-07", Name = "Priority Preservation", Condition = "High-priority outlet is active during shedding", Action = "ACT_PRESERVE(i)" },
                new ControlPolicy { Code = "POL-08", Name = "Standby Load Management", Condition = "P_branch_i stays below standby threshold for 30 minutes", Action = "ACT_SHED(i)" });
        }

        if (!_context.PowerEvents.Any())
        {
            _context.PowerEvents.AddRange(
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Dashboard synchronized", Detail = "Policies loaded for six outlets with dedicated PZEM meters, CTs, and relay channels.", Severity = EventSeverity.Info },
                new PowerEvent { Timestamp = DateTimeOffset.UtcNow, Title = "Normal operating state", Detail = "Total load is below warning threshold.", Severity = EventSeverity.Success });
        }

        await _context.SaveChangesAsync();
    }
}
