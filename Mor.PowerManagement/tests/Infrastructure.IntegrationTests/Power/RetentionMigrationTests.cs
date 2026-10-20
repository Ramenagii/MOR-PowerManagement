using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Operations;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Npgsql;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>PLAN-0001 Spec F: the retention migration is additive and protects history.</summary>
[NonParallelizable]
public class RetentionMigrationTests
{
    private const string Migration = "20261020090000_TelemetryMinuteRetention";
    private const string Previous = "20261019220000_BufferedTelemetryPersistence";

    [Test]
    public async Task Up_PreservesExistingHistoryAndRawSqlRollups_AndProtectsItFromOutletDeletes()
    {
        await using var fixture = await PostgresFixture.CreateAsync();
        await using var db = fixture.CreateMigrationContext();
        await db.GetService<IMigrator>().MigrateAsync(Previous);
        Assert.That(await db.Database.GetAppliedMigrationsAsync(), Does.Not.Contain(Migration));

        var at = new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
        // The migration leaves Outlets and TelemetryReadings columns as they were, so the current model can write them.
        db.Outlets.AddRange(new Outlet { Id = 1, Name = "Outlet 1", RelayChannel = "Relay CH1" }, new Outlet { Id = 2, Name = "Outlet 2", RelayChannel = "Relay CH2" });
        db.TelemetryReadings.AddRange(RetentionRig.Reading(1, at, 100, 1), RetentionRig.Reading(2, at, 100, 1));
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryReadingRollups" ("OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt")
            VALUES (1, {at}, 3, 690, 3, 300, 230, 230, 100, 1, {at}, 1, {at})
            """);
        var indexesBefore = await RollupIndexesAsync(db);

        await db.Database.MigrateAsync();

        Assert.That(await db.Database.GetAppliedMigrationsAsync(), Does.Contain(Migration));
        Assert.That(await db.TelemetryReadings.CountAsync(), Is.EqualTo(2));
        Assert.That(await CountAsync(db, """SELECT count(*) FROM "TelemetryReadingRollups" WHERE "SampleCount" = 3"""), Is.EqualTo(1));
        Assert.That(await RollupIndexesAsync(db), Is.EquivalentTo(indexesBefore), "raw-SQL rollup indexes kept");
        Assert.That(await CountAsync(db, """
            SELECT count(*) FROM pg_constraint
            WHERE contype = 'f' AND confrelid = '"Outlets"'::regclass AND confdeltype = 'r'
              AND conrelid IN ('"TelemetryReadings"'::regclass, '"TelemetryReadingRollups"'::regclass, '"TelemetryMinuteRollups"'::regclass)
            """), Is.EqualTo(3), "history foreign keys are ON DELETE RESTRICT");

        db.TelemetryMinuteRollups.Add(new TelemetryMinuteRollup { OutletId = 2, BucketStart = at, SampleCount = 1, FirstSampleAt = at, LatestSampleAt = at });
        await db.SaveChangesAsync();
        foreach (var outlet in new[] { 1, 2 })
        {
            var error = Assert.ThrowsAsync<PostgresException>(() =>
                db.Database.ExecuteSqlInterpolatedAsync($"""DELETE FROM "Outlets" WHERE "Id" = {outlet}"""));
            // ON DELETE RESTRICT reports restrict_violation (23001), not foreign_key_violation (23503).
            Assert.That(error!.SqlState, Is.EqualTo(PostgresErrorCodes.RestrictViolation));
        }

        await db.Database.ExecuteSqlRawAsync("""DELETE FROM "TelemetryReadings" WHERE "OutletId" = 2; DELETE FROM "TelemetryMinuteRollups" WHERE "OutletId" = 2""");
        Assert.That(await db.Database.ExecuteSqlRawAsync("""DELETE FROM "Outlets" WHERE "Id" = 2"""), Is.EqualTo(1), "an outlet without history can still go");
    }

    [Test]
    public async Task Up_HasNoDestructiveOperations_AndTheModelSnapshotIsCurrent()
    {
        await using var fixture = await PostgresFixture.CreateAsync();
        await using var db = fixture.CreateMigrationContext();
        var assembly = db.GetService<IMigrationsAssembly>();
        var migration = assembly.CreateMigration(assembly.Migrations[Migration], db.Database.ProviderName!);

        var drops = migration.UpOperations.Where(o => o is DropTableOperation or DropColumnOperation or DropIndexOperation or DropPrimaryKeyOperation).ToList();
        Assert.That(drops, Is.Empty);
        var sql = migration.UpOperations.OfType<SqlOperation>().Select(o => o.Sql.ToUpperInvariant()).ToList();
        Assert.That(sql, Has.None.Contains("DROP TABLE").And.None.Contains("DROP INDEX").And.None.Contains("DROP COLUMN").And.None.Contains("DELETE FROM"));

        Assert.That(db.Database.HasPendingModelChanges(), Is.False, "hand-written snapshot matches the model");
    }

    private static async Task<long> CountAsync(DbContext db, string sql)
    {
        var connection = (NpgsqlConnection)db.Database.GetDbConnection();
        if (connection.State != System.Data.ConnectionState.Open) await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        return (long)(await command.ExecuteScalarAsync())!;
    }

    private static async Task<List<string>> RollupIndexesAsync(DbContext db) =>
        await db.Database.SqlQueryRaw<string>("""
            SELECT indexdef AS "Value" FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'TelemetryReadingRollups'
            """).ToListAsync();
}
