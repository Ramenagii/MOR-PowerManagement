using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <summary>
    /// Telemetry history support: device-reported metering provenance, and a BRIN
    /// index to make the bounded series query cheap on an append-only table.
    ///
    /// Expected query shape after this migration (what the telemetry graph runs):
    /// <code>
    /// Aggregate (cost=... rows=4680 width=...)
    ///   GroupKey: date_bin(...), t."OutletId"
    ///   ->  Index Scan using IX_TelemetryReadings_Timestamp_brin on "TelemetryReadings" t
    ///         Index Cond: (t."Timestamp" &gt;= '...' AND t."Timestamp" &lt; '...')
    ///         Rows Removed by Index Recheck: 0
    ///   ->  Sort  (quicksort)
    /// </code>
    ///
    /// Why BRIN and not another btree: a ("Timestamp", "OutletId") btree would also
    /// work, but costs roughly 30-40 MB on 1.5M rows and needs a full blocking index
    /// build. A covering btree with INCLUDE (Voltage, CurrentAmps, PowerWatts) would
    /// avoid heap fetches but inflates the index about 2x for under 50 ms on a 24 h
    /// window. The table is append-only and physically ordered by Timestamp, so BRIN
    /// correlation is ~1.0: it gives near-btree range pruning at ~0.01% of the size,
    /// and is created without a table rewrite, which matters on the live Neon DB.
    /// </summary>
    public partial class TelemetrySeriesSupport : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "MeteringMode",
                table: "PowerSystemConfigs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "MeteringModeUpdatedAt",
                table: "PowerSystemConfigs",
                type: "timestamp with time zone",
                nullable: true);

            // Raw SQL rather than migrationBuilder.CreateIndex: EF Core 10's fluent
            // API has no HasPagesPerRange, so pages_per_range = 32 cannot be
            // expressed on the model. The index IS still declared in
            // TelemetryReadingConfiguration, so it does appear in
            // ApplicationDbContextModelSnapshot (as brin, default pages_per_range)
            // and EF will not emit a duplicate CreateIndex in a later migration.
            // The one model/database divergence is that storage parameter, which
            // EF never reconciles.
            migrationBuilder.Sql(
                """
                CREATE INDEX IF NOT EXISTS "IX_TelemetryReadings_Timestamp_brin"
                    ON "TelemetryReadings" USING BRIN ("Timestamp") WITH (pages_per_range = 32);
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"IX_TelemetryReadings_Timestamp_brin\";");

            migrationBuilder.DropColumn(
                name: "MeteringMode",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "MeteringModeUpdatedAt",
                table: "PowerSystemConfigs");
        }
    }
}
