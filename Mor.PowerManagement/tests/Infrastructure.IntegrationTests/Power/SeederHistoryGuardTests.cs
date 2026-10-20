using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>
/// PLAN-0001 Spec F: once raw history is kept for seven days, the startup
/// seeder must never delete or relabel an outlet's retained history.
/// </summary>
[NonParallelizable]
public class SeederHistoryGuardTests
{
    private PostgresFixture database = null!;
    private IHost app = null!;

    [SetUp]
    public async Task SetUp()
    {
        database = await PostgresFixture.CreateAsync();
        var settings = new Dictionary<string, string?>
        {
            // Throwaway credential for the isolated schema; never printed.
            ["Admin:InitialPassword"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)) + "aA1!",
        };
        app = RetentionRig.BuildHost(database, new ControlScenarioRunner(database), v2: true, settings: settings);
        await SeedAsync();
    }

    [TearDown]
    public async Task TearDown()
    {
        app.Dispose();
        await database.DisposeAsync();
    }

    [Test]
    public async Task CurrentTestingRigSeed_RerunsCleanly_OverRetainedHistoryForEveryOutlet()
    {
        await AddHistoryAsync(1, 2, 3, 4, 5);
        var before = await SnapshotAsync();
        Assert.That(before.Outlets, Has.Count.EqualTo(5));

        await SeedAsync();

        var after = await SnapshotAsync();
        Assert.That(after.Outlets, Is.EqualTo(before.Outlets), "no relabels");
        Assert.That(after.History, Is.EqualTo(before.History), "no history deleted");
        Assert.That(after.History, Is.EqualTo(new[] { 5L, 5L, 5L }));
    }

    [Test]
    public async Task IdentityChange_OverRetainedHistory_StopsStartup_NamingOnlyTheOutletAndReason()
    {
        await AddHistoryAsync(2);
        await RenameAsync(2, "Outlet 2 (old bench)", "Relay CH9");
        var before = await SnapshotAsync();

        var error = Assert.ThrowsAsync<InvalidOperationException>(SeedAsync);

        Assert.That(error!.Message, Does.Contain("Outlet 2 ('Outlet 2 (old bench)')").And.Contain("change its identity to 'Outlet 2' on 'Relay CH2'"));
        AssertNoConnectionDetails(error.Message);
        Assert.That(await SnapshotAsync(), Is.EqualTo(before).Using<Snapshot>((a, b) =>
            a.Outlets.SequenceEqual(b.Outlets) && a.History.SequenceEqual(b.History)), "nothing deleted or relabelled");
    }

    [Test]
    public async Task StaleOutletWithRetainedHistory_IsNotRemoved()
    {
        await using (var db = database.CreateMigrationContext())
        {
            db.Outlets.Add(new Outlet { Id = 7, Name = "Outlet 7", RelayChannel = "Relay CH7" });
            await db.SaveChangesAsync();
        }
        await AddHistoryAsync(7);
        var before = await SnapshotAsync();

        var error = Assert.ThrowsAsync<InvalidOperationException>(SeedAsync);

        Assert.That(error!.Message, Does.Contain("Outlet 7 ('Outlet 7')").And.Contain("not in the testing-rig roster"));
        AssertNoConnectionDetails(error.Message);
        var after = await SnapshotAsync();
        Assert.That(after.Outlets, Is.EqualTo(before.Outlets));
        Assert.That(after.History, Is.EqualTo(before.History));
    }

    [Test]
    public async Task IdentityChange_WithoutHistory_StillRelabels()
    {
        await AddHistoryAsync(1);
        await RenameAsync(3, "Something else", "Relay CH8");

        await SeedAsync();

        var outlet = (await SnapshotAsync()).Outlets.Single(o => o.StartsWith("3|", StringComparison.Ordinal));
        Assert.That(outlet, Does.StartWith("3|Outlet 3|Relay CH3|"));
    }

    private async Task SeedAsync()
    {
        await using var scope = app.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ApplicationDbContextInitialiser>().TrySeedAsync();
    }

    private async Task RenameAsync(int id, string name, string relay)
    {
        await using var db = database.CreateMigrationContext();
        var outlet = await db.Outlets.SingleAsync(o => o.Id == id);
        outlet.Name = name;
        outlet.RelayChannel = relay;
        await db.SaveChangesAsync();
    }

    private async Task AddHistoryAsync(params int[] outlets)
    {
        var at = new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
        await using var db = database.CreateMigrationContext();
        foreach (var id in outlets)
        {
            db.TelemetryReadings.Add(RetentionRig.Reading(id, at, 100, 1));
            db.TelemetryMinuteRollups.Add(new TelemetryMinuteRollup { OutletId = id, BucketStart = at, SampleCount = 1, FirstSampleAt = at, LatestSampleAt = at });
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO "TelemetryReadingRollups" ("OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                    "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt")
                VALUES ({id}, {at}, 1, 230, 1, 100, 230, 230, 100, 1, {at}, 1, {at})
                """);
        }

        await db.SaveChangesAsync();
    }

    private async Task<Snapshot> SnapshotAsync()
    {
        await using var db = database.CreateMigrationContext();
        var outlets = (await db.Outlets.AsNoTracking().OrderBy(o => o.Id).ToListAsync())
            .Select(o => $"{o.Id}|{o.Name}|{o.RelayChannel}|{o.MeterChannel}|{JsonSerializer.Serialize(o)}").ToList();
        var history = new List<long>
        {
            await db.TelemetryReadings.LongCountAsync(),
            await db.TelemetryMinuteRollups.LongCountAsync(),
            await db.Database.SqlQuery<long>($"""SELECT count(*) AS "Value" FROM "TelemetryReadingRollups" """).SingleAsync(),
        };
        return new Snapshot(outlets, history);
    }

    private void AssertNoConnectionDetails(string message)
    {
        Assert.That(message, Does.Not.Contain(database.SchemaName).And.Not.Contain("127.0.0.1").And.Not.Contain("Password")
            .And.Not.Contain("Host=").And.Not.Contain("mor_test"));
    }

    private sealed record Snapshot(List<string> Outlets, List<long> History);
}
