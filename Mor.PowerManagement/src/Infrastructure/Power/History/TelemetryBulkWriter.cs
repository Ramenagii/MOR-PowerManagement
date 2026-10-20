using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Observability;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>Short, ordered transactions. A retried batch first checks its transactional watermark.</summary>
public sealed class TelemetryBulkWriter(IServiceScopeFactory scopes)
{
    public async Task InitializeAsync(BoundedHistoryBuffer buffer, CancellationToken token)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var checkpoints = await db.TelemetryPersistenceCheckpoints.AsNoTracking().ToListAsync(token);
        var history = checkpoints.Find(c => c.Stream == "history");
        var live = checkpoints.Find(c => c.Stream == "live-state");
        buffer.Initialize(history?.LastCommittedOrdinal ?? 0, live?.LastCommittedOrdinal ?? 0,
            history?.CommittedAcquisitions ?? 0, history?.CommittedRows ?? 0,
            history?.DroppedAcquisitions ?? 0, history?.DroppedRows ?? 0, history?.LastGapFromUtc, history?.LastGapToUtc);
    }

    public async Task WriteAsync(HistoryBatch batch, CancellationToken token)
    {
        using var activity = TelemetryActivityScope.Begin(TelemetryActivityCategory.RetentionBulk);
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await db.Database.BeginTransactionAsync(token);
        // This row serializes checkpoint updates with immediate control transactions.
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO "TelemetryPersistenceCheckpoints" ("Stream", "LastCommittedOrdinal", "CommittedAcquisitions", "CommittedRows", "DroppedAcquisitions", "DroppedRows")
            VALUES ('live-state', 0, 0, 0, 0, 0) ON CONFLICT DO NOTHING;
            SELECT 1 FROM "TelemetryPersistenceCheckpoints" WHERE "Stream" = 'live-state' FOR UPDATE;
            """, token);
        var history = await db.TelemetryPersistenceCheckpoints.AsNoTracking().FirstOrDefaultAsync(c => c.Stream == "history", token);
        if (history is not null && history.LastCommittedOrdinal >= batch.Acquisitions[^1].Ordinal)
        {
            await transaction.CommitAsync(token);
            return;
        }
        var samples = JsonSerializer.Serialize(batch.Acquisitions.SelectMany(a => a.Samples.Select((s, i) => new
        {
            s.OutletId, a.Timestamp, s.Voltage, s.CurrentAmps, s.PowerWatts, s.EnergyKwh,
            AcquisitionOrdinal = a.Ordinal, SampleOrdinal = (short)i,
        })));
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryReadings" ("OutletId", "Timestamp", "Voltage", "CurrentAmps", "PowerWatts", "EnergyKwh", "AcquisitionOrdinal", "SampleOrdinal")
            SELECT * FROM jsonb_to_recordset({samples}::jsonb) AS r("OutletId" int, "Timestamp" timestamptz,
                "Voltage" float8, "CurrentAmps" float8, "PowerWatts" float8, "EnergyKwh" float8, "AcquisitionOrdinal" bigint, "SampleOrdinal" smallint)
            """, token);
        var ina = JsonSerializer.Serialize(batch.Acquisitions.Where(a => a.Ina is not null).Select(a => new
        {
            a.Timestamp, a.Ina!.BusVoltageV, a.Ina.ShuntVoltageMv, a.Ina.CurrentA, a.Ina.PowerW, AcquisitionOrdinal = a.Ordinal,
        }));
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "InaReadings" ("Timestamp", "BusVoltageV", "ShuntVoltageMv", "CurrentA", "PowerW", "AcquisitionOrdinal")
            SELECT * FROM jsonb_to_recordset({ina}::jsonb) AS r("Timestamp" timestamptz, "BusVoltageV" float8,
                "ShuntVoltageMv" float8, "CurrentA" float8, "PowerW" float8, "AcquisitionOrdinal" bigint)
            """, token);

        var latest = batch.Acquisitions[^1];
        var liveOrdinal = await db.TelemetryPersistenceCheckpoints.Where(c => c.Stream == "live-state")
            .Select(c => c.LastCommittedOrdinal).SingleAsync(token);
        if (latest.Ordinal > liveOrdinal)
        {
            var live = latest.Live;
            var outlets = JsonSerializer.Serialize(live.Outlets);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE "Outlets" o SET "CurrentWatts" = r."CurrentWatts", "LastSeen" = r."LastSeen"
                FROM jsonb_to_recordset({outlets}::jsonb) AS r("OutletId" int, "CurrentWatts" float8, "LastSeen" timestamptz)
                WHERE o."Id" = r."OutletId";
                UPDATE "PowerSystemConfigs" SET "LastAcquisitionSessionId" = {live.LastAcquisitionSessionId},
                    "LastAcquisitionSequence" = {live.LastAcquisitionSequence}, "MeteringMode" = {(int)live.MeteringMode},
                    "MeteringModeUpdatedAt" = {live.MeteringModeUpdatedAt} WHERE "Id" = {live.ConfigId};
                UPDATE "TelemetryPersistenceCheckpoints" SET "LastCommittedOrdinal" = {latest.Ordinal}
                    WHERE "Stream" = 'live-state';
                """, token);
        }
        var count = batch.Acquisitions.Length;
        var rows = batch.Acquisitions.Sum(a => a.RowCount);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "TelemetryPersistenceCheckpoints" ("Stream", "LastCommittedOrdinal", "LastBatchId", "LastCommittedAtUtc",
                "CommittedAcquisitions", "CommittedRows", "DroppedAcquisitions", "DroppedRows", "LastGapFromUtc", "LastGapToUtc")
            VALUES ('history', {latest.Ordinal}, {batch.Id}, {latest.Timestamp}, {count}, {rows}, {batch.DroppedAcquisitions}, {batch.DroppedRows}, {batch.GapFrom}, {batch.GapTo})
            ON CONFLICT ("Stream") DO UPDATE SET "LastCommittedOrdinal" = EXCLUDED."LastCommittedOrdinal",
                "LastBatchId" = EXCLUDED."LastBatchId", "LastCommittedAtUtc" = EXCLUDED."LastCommittedAtUtc",
                "CommittedAcquisitions" = "TelemetryPersistenceCheckpoints"."CommittedAcquisitions" + EXCLUDED."CommittedAcquisitions",
                "CommittedRows" = "TelemetryPersistenceCheckpoints"."CommittedRows" + EXCLUDED."CommittedRows",
                "DroppedAcquisitions" = EXCLUDED."DroppedAcquisitions", "DroppedRows" = EXCLUDED."DroppedRows",
                "LastGapFromUtc" = EXCLUDED."LastGapFromUtc", "LastGapToUtc" = EXCLUDED."LastGapToUtc";
            """, token);
        await transaction.CommitAsync(token);
    }
}
