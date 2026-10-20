using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;
using Mor.PowerManagement.Infrastructure.Power.History;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power;

/// <summary>
/// PLAN-0001 Spec F capacity gate, measured on the local throwaway database.
/// Full rig without USB: 8 x 220 V + 1 x 110 V channels plus the INA226 mirror
/// row (10 outlet rows per second, conservatively) and the INA226 stream, at
/// 1 Hz for 15 h a day. Raw is kept 7 days; minute and five-minute summaries
/// and events through day 30. Several daily insert / compact / prune / VACUUM
/// cycles run first so the figure includes reuse and bloat, not a fresh load.
/// Slow (millions of rows), so it only runs when asked for explicitly.
/// </summary>
[Explicit("Capacity measurement: several minutes and ~1 GB of local disk churn.")]
[Category("Capacity")]
[NonParallelizable]
public class RetentionCapacityTests
{
    private const long BudgetBytes = 800L * 1024 * 1024;
    private const int Outlets = 10;
    private const int SecondsPerDay = 15 * 3600;
    private const int EventsPerDay = 500;
    private const int SimulatedDays = 12;

    [Test]
    public async Task SteadyStateFootprint_FitsTheFreeTierBudget()
    {
        await using var rig = await RetentionRig.Create();
        var origin = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        await using (var db = rig.Database.CreateMigrationContext())
        {
            for (var id = 6; id <= Outlets; id++) db.Outlets.Add(new Outlet { Id = id, Name = $"Outlet {id}", RelayChannel = $"Relay CH{id}" });
            await db.SaveChangesAsync();

            // Summaries older than the simulated days (as left by compaction or the
            // legacy job), so the summary tier spans the full 30 days at the end.
            var summaryDays = 30 - (SimulatedDays - 7);
            // A sample lives in exactly one tier (compaction consumes the raw rows), so no
            // summary overlaps the raw days.
            await InsertSummariesAsync(db, origin - TimeSpan.FromDays(summaryDays), summaryDays);
        }

        long peak = 0;
        var log = TestContext.Out;
        for (var day = 0; day < SimulatedDays; day++)
        {
            var dayStart = origin + TimeSpan.FromDays(day);
            await using var db = rig.Database.CreateMigrationContext();
            db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
            await InsertRawDayAsync(db, dayStart, day);
            peak = Math.Max(peak, await SchemaBytesAsync(db));

            // The next morning's maintenance windows, run to completion.
            rig.Run.Clock.SetUtcNow(dayStart + TimeSpan.FromHours(30));
            var moved = await DrainAsync(rig, TelemetryCompactionCheckpoint.TelemetryStream) + await DrainAsync(rig, TelemetryCompactionCheckpoint.InaStream);
            while (!(await rig.Compaction.PruneSummariesAsync(rig.Now, DateTimeOffset.MaxValue, default)).Complete) { }
            while (!(await rig.Events.PruneAsync(rig.Now, DateTimeOffset.MaxValue, default)).Complete) { }
            await db.Database.ExecuteSqlRawAsync("VACUUM");
            log.WriteLine($"day {day + 1}: compacted {moved} rows; schema {Mb(await SchemaBytesAsync(db))}");
        }

        await using (var db = rig.Database.CreateMigrationContext())
        {
            await db.Database.ExecuteSqlRawAsync("ANALYZE");
            var tables = await db.Database.SqlQueryRaw<TableSize>("""
                SELECT c.relname AS "Name", c.reltuples::bigint AS "Rows",
                       pg_table_size(c.oid) AS "TableBytes", pg_indexes_size(c.oid) AS "IndexBytes", pg_total_relation_size(c.oid) AS "TotalBytes"
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relkind = 'r'
                ORDER BY pg_total_relation_size(c.oid) DESC
                """).ToListAsync();
            foreach (var t in tables.Where(t => t.TotalBytes > 1024 * 1024))
                log.WriteLine($"{t.Name,-32} rows {t.Rows,10:N0}  table {Mb(t.TableBytes),9}  indexes {Mb(t.IndexBytes),9}  total {Mb(t.TotalBytes),9}");
            var raw = tables.Single(t => t.Name == "TelemetryReadings");
            log.WriteLine($"raw bytes/row incl. indexes: {raw.TotalBytes / (double)Math.Max(1, raw.Rows):F0}");

            var total = tables.Sum(t => t.TotalBytes);
            var stopwatch = Stopwatch.StartNew();
            var series = await new GetTelemetrySeriesQueryHandler(db, new NoBuffer(), null!, new HistoryTailMerger(), rig.Run.Clock)
                .Handle(new GetTelemetrySeriesQuery { Window = TelemetryWindow.Days7 }, default);
            log.WriteLine($"7d query: {stopwatch.ElapsedMilliseconds} ms over {series.RawSampleCount:N0} samples");
            log.WriteLine($"steady state after maintenance: {Mb(total)}; peak before a day's compaction: {Mb(peak)}; budget {Mb(BudgetBytes)}");

            Assert.That(await db.TelemetryReadings.MinAsync(r => r.Timestamp), Is.GreaterThan(rig.Now - TimeSpan.FromDays(7) - TimeSpan.FromMinutes(1)));
            Assert.That(total, Is.LessThanOrEqualTo(BudgetBytes), $"steady-state footprint {Mb(total)} exceeds {Mb(BudgetBytes)}");
        }
    }

    private static async Task<long> DrainAsync(RetentionRig rig, string stream)
    {
        long rows = 0;
        CompactionOutcome outcome;
        do
        {
            outcome = await rig.Compaction.CompactAsync(stream, rig.Now, DateTimeOffset.MaxValue, default);
            rows += outcome.Rows;
        } while (outcome.State != CompactionState.Complete);

        return rows;
    }

    private static async Task InsertRawDayAsync(Microsoft.EntityFrameworkCore.DbContext db, DateTimeOffset dayStart, int day)
    {
        var first = dayStart + TimeSpan.FromHours(7);
        long ordinalBase = (long)day * SecondsPerDay;
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryReadings" ("OutletId", "Timestamp", "Voltage", "CurrentAmps", "PowerWatts", "EnergyKwh", "AcquisitionOrdinal", "SampleOrdinal")
            SELECT o, {first} + make_interval(secs => s),
                   CASE WHEN o = 9 THEN 110 ELSE 220 END + random() * 8, random() * 2.2, random() * 480,
                   {day} * 12.0 + s * 0.00012 + o, {ordinalBase} + s, (o - 1)::smallint
            FROM generate_series(0, {SecondsPerDay - 1}) s, generate_series(1, {Outlets}) o
            ORDER BY s, o
            """);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "InaReadings" ("Timestamp", "BusVoltageV", "ShuntVoltageMv", "CurrentA", "PowerW", "AcquisitionOrdinal")
            SELECT {first} + make_interval(secs => s), 5 + random() * 0.2, random() * 40, random() * 2, random() * 10, {ordinalBase} + s
            FROM generate_series(0, {SecondsPerDay - 1}) s
            """);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "PowerEvents" ("Timestamp", "Title", "Detail", "Severity", "Created", "LastModified")
            SELECT {first} + make_interval(secs => s * 100), 'Outlet ' || (s % 10 + 1) || ' relay command acknowledged',
                   repeat('Relay command issued by the load-shedding framework and acknowledged by the board. ', 3), 0, {first}, {first}
            FROM generate_series(0, {EventsPerDay - 1}) s
            """);
    }

    private static async Task InsertSummariesAsync(Microsoft.EntityFrameworkCore.DbContext db, DateTimeOffset from, int days)
    {
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryMinuteRollups" ("OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                "MinVoltage", "MaxVoltage", "MinCurrentAmps", "MaxCurrentAmps", "MinPowerWatts", "MaxPowerWatts",
                "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt", "MaxEnergyKwh")
            SELECT o, b, 60, 13500 + random(), 60 * random(), 14000 * random(), 220, 228, 0, 2, 0, 480,
                   o + random(), b, o + random(), b + interval '59 seconds', o + random()
            FROM generate_series(0, {days - 1}) d,
                 LATERAL generate_series({from} + make_interval(days => d) + interval '7 hours',
                                         {from} + make_interval(days => d) + interval '22 hours' - interval '1 minute', interval '1 minute') b,
                 generate_series(1, {Outlets}) o
            """);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "InaMinuteRollups" ("BucketStart", "SampleCount", "BusVoltageVCount", "BusVoltageVSum", "MinBusVoltageV", "MaxBusVoltageV",
                "ShuntVoltageMvCount", "ShuntVoltageMvSum", "MinShuntVoltageMv", "MaxShuntVoltageMv", "CurrentACount", "CurrentASum", "MinCurrentA", "MaxCurrentA",
                "PowerWCount", "PowerWSum", "MinPowerW", "MaxPowerW", "FirstSampleAt", "LatestSampleAt")
            SELECT b, 60, 60, 300 + random(), 5, 5.2, 60, 1200 * random(), 0, 40, 60, 60 * random(), 0, 2, 60, 300 * random(), 0, 10, b, b + interval '59 seconds'
            FROM generate_series(0, {days - 1}) d,
                 LATERAL generate_series({from} + make_interval(days => d) + interval '7 hours',
                                         {from} + make_interval(days => d) + interval '22 hours' - interval '1 minute', interval '1 minute') b
            """);
        await InsertFiveMinuteAsync(db, from, days);
    }

    private static async Task InsertFiveMinuteAsync(Microsoft.EntityFrameworkCore.DbContext db, DateTimeOffset from, int days)
    {
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryReadingRollups" ("OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt")
            SELECT o, b, 300, 67500 + random(), 300 * random(), 70000 * random(), 220, 228, 480, o + random(), b, o + random(), b + interval '299 seconds'
            FROM generate_series(0, {days - 1}) d,
                 LATERAL generate_series({from} + make_interval(days => d) + interval '7 hours',
                                         {from} + make_interval(days => d) + interval '22 hours' - interval '5 minutes', interval '5 minutes') b,
                 generate_series(1, {Outlets}) o
            ON CONFLICT DO NOTHING
            """);
    }

    private static async Task<long> SchemaBytesAsync(Microsoft.EntityFrameworkCore.DbContext db) =>
        await db.Database.SqlQueryRaw<long>("""
            SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS "Value"
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind = 'r'
            """).SingleAsync();

    private static string Mb(long bytes) => $"{bytes / 1024.0 / 1024.0:F1} MB";

    private sealed record TableSize(string Name, long Rows, long TableBytes, long IndexBytes, long TotalBytes);

    private sealed class NoBuffer : IHistoryBuffer
    {
        public bool Enabled => false;
        public long ReserveOrdinal() => throw new NotSupportedException();
        public HistoryAcceptance Accept(AcceptedAcquisition a) => throw new NotSupportedException();
        public HistoryTailCapture CaptureTail() => throw new NotSupportedException();
        public HistoryPersistenceStatus GetStatus() => HistoryPersistenceStatus.Synchronous;
    }
}
