using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <summary>
    /// PLAN-0001 Spec F. Additive: the 30-day minute tier (outlet and INA226),
    /// the compaction checkpoint table, and outlet foreign keys switched from
    /// CASCADE to RESTRICT so removing an outlet can never delete its retained
    /// history. No table, column or index is dropped.
    ///
    /// The raw-SQL TelemetryReadingRollups table and its
    /// IX_TelemetryReadingRollups_BucketStart index
    /// (20261019030000_TelemetryRollups) are not part of the EF model. Only
    /// their outlet foreign key is replaced (same column, RESTRICT); the table,
    /// its rows and its indexes are kept as they are. Down is provided for
    /// completeness only; rollback is a flag change, never a down-migration.
    /// </summary>
    public partial class TelemetryMinuteRetention : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_TelemetryReadings_Outlets_OutletId",
                table: "TelemetryReadings");

            migrationBuilder.CreateTable(
                name: "InaMinuteRollups",
                columns: table => new
                {
                    BucketStart = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    SampleCount = table.Column<long>(type: "bigint", nullable: false),
                    BusVoltageVCount = table.Column<long>(type: "bigint", nullable: false),
                    BusVoltageVSum = table.Column<double>(type: "double precision", nullable: true),
                    MinBusVoltageV = table.Column<double>(type: "double precision", nullable: true),
                    MaxBusVoltageV = table.Column<double>(type: "double precision", nullable: true),
                    ShuntVoltageMvCount = table.Column<long>(type: "bigint", nullable: false),
                    ShuntVoltageMvSum = table.Column<double>(type: "double precision", nullable: true),
                    MinShuntVoltageMv = table.Column<double>(type: "double precision", nullable: true),
                    MaxShuntVoltageMv = table.Column<double>(type: "double precision", nullable: true),
                    CurrentACount = table.Column<long>(type: "bigint", nullable: false),
                    CurrentASum = table.Column<double>(type: "double precision", nullable: true),
                    MinCurrentA = table.Column<double>(type: "double precision", nullable: true),
                    MaxCurrentA = table.Column<double>(type: "double precision", nullable: true),
                    PowerWCount = table.Column<long>(type: "bigint", nullable: false),
                    PowerWSum = table.Column<double>(type: "double precision", nullable: true),
                    MinPowerW = table.Column<double>(type: "double precision", nullable: true),
                    MaxPowerW = table.Column<double>(type: "double precision", nullable: true),
                    FirstSampleAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LatestSampleAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InaMinuteRollups", x => x.BucketStart);
                });

            migrationBuilder.CreateTable(
                name: "TelemetryCompactionCheckpoints",
                columns: table => new
                {
                    Stream = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    MinuteCoverageFromUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastCutoffUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastCompactedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CompactedRows = table.Column<long>(type: "bigint", nullable: false),
                    CompactedBatches = table.Column<long>(type: "bigint", nullable: false),
                    LastBatchRows = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelemetryCompactionCheckpoints", x => x.Stream);
                });

            migrationBuilder.CreateTable(
                name: "TelemetryMinuteRollups",
                columns: table => new
                {
                    OutletId = table.Column<int>(type: "integer", nullable: false),
                    BucketStart = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    SampleCount = table.Column<long>(type: "bigint", nullable: false),
                    VoltageSum = table.Column<double>(type: "double precision", nullable: false),
                    CurrentAmpsSum = table.Column<double>(type: "double precision", nullable: false),
                    PowerWattsSum = table.Column<double>(type: "double precision", nullable: false),
                    MinVoltage = table.Column<double>(type: "double precision", nullable: false),
                    MaxVoltage = table.Column<double>(type: "double precision", nullable: false),
                    MinCurrentAmps = table.Column<double>(type: "double precision", nullable: false),
                    MaxCurrentAmps = table.Column<double>(type: "double precision", nullable: false),
                    MinPowerWatts = table.Column<double>(type: "double precision", nullable: false),
                    MaxPowerWatts = table.Column<double>(type: "double precision", nullable: false),
                    FirstEnergyKwh = table.Column<double>(type: "double precision", nullable: false),
                    FirstSampleAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastEnergyKwh = table.Column<double>(type: "double precision", nullable: false),
                    MaxEnergyKwh = table.Column<double>(type: "double precision", nullable: false),
                    LatestSampleAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelemetryMinuteRollups", x => new { x.OutletId, x.BucketStart });
                    table.ForeignKey(
                        name: "FK_TelemetryMinuteRollups_Outlets_OutletId",
                        column: x => x.OutletId,
                        principalTable: "Outlets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TelemetryMinuteRollups_BucketStart",
                table: "TelemetryMinuteRollups",
                column: "BucketStart");

            migrationBuilder.AddForeignKey(
                name: "FK_TelemetryReadings_Outlets_OutletId",
                table: "TelemetryReadings",
                column: "OutletId",
                principalTable: "Outlets",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);

            // Raw-SQL five-minute rollups: replace only the outlet foreign key.
            // It was declared inline without a name, so PostgreSQL named it; find
            // it by relation instead of guessing. The table, its rows and
            // IX_TelemetryReadingRollups_BucketStart are untouched.
            migrationBuilder.Sql("""
                DO $$
                DECLARE fk record;
                BEGIN
                    FOR fk IN
                        SELECT c.conname FROM pg_constraint c
                        WHERE c.conrelid = '"TelemetryReadingRollups"'::regclass
                          AND c.confrelid = '"Outlets"'::regclass
                          AND c.contype = 'f'
                    LOOP
                        EXECUTE format('ALTER TABLE "TelemetryReadingRollups" DROP CONSTRAINT %I', fk.conname);
                    END LOOP;
                END $$;

                ALTER TABLE "TelemetryReadingRollups"
                    ADD CONSTRAINT "FK_TelemetryReadingRollups_Outlets_OutletId"
                    FOREIGN KEY ("OutletId") REFERENCES "Outlets" ("Id") ON DELETE RESTRICT;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                ALTER TABLE "TelemetryReadingRollups"
                    DROP CONSTRAINT IF EXISTS "FK_TelemetryReadingRollups_Outlets_OutletId";

                ALTER TABLE "TelemetryReadingRollups"
                    ADD CONSTRAINT "TelemetryReadingRollups_OutletId_fkey"
                    FOREIGN KEY ("OutletId") REFERENCES "Outlets" ("Id") ON DELETE CASCADE;
                """);

            migrationBuilder.DropForeignKey(
                name: "FK_TelemetryReadings_Outlets_OutletId",
                table: "TelemetryReadings");

            migrationBuilder.DropTable(
                name: "InaMinuteRollups");

            migrationBuilder.DropTable(
                name: "TelemetryCompactionCheckpoints");

            migrationBuilder.DropTable(
                name: "TelemetryMinuteRollups");

            migrationBuilder.AddForeignKey(
                name: "FK_TelemetryReadings_Outlets_OutletId",
                table: "TelemetryReadings",
                column: "OutletId",
                principalTable: "Outlets",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
