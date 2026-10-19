using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <summary>
    /// PLAN-0001 Spec E. Additive only: two nullable identity columns on
    /// TelemetryReadings, one on InaReadings (metadata-only in PostgreSQL, no
    /// table rewrite, existing rows stay NULL), and the checkpoint table.
    ///
    /// The raw-SQL TelemetryReadingRollups table and its indexes
    /// (20261019030000_TelemetryRollups) are not part of the EF model, so this
    /// migration neither creates nor drops them; they are left exactly as they
    /// are. Down is provided for completeness only; rollback is a flag change,
    /// never a down-migration.
    /// </summary>
    public partial class BufferedTelemetryPersistence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "AcquisitionOrdinal",
                table: "TelemetryReadings",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<short>(
                name: "SampleOrdinal",
                table: "TelemetryReadings",
                type: "smallint",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "AcquisitionOrdinal",
                table: "InaReadings",
                type: "bigint",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "TelemetryPersistenceCheckpoints",
                columns: table => new
                {
                    Stream = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    LastCommittedOrdinal = table.Column<long>(type: "bigint", nullable: false),
                    LastBatchId = table.Column<Guid>(type: "uuid", nullable: true),
                    LastCommittedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CommittedAcquisitions = table.Column<long>(type: "bigint", nullable: false),
                    CommittedRows = table.Column<long>(type: "bigint", nullable: false),
                    DroppedAcquisitions = table.Column<long>(type: "bigint", nullable: false),
                    DroppedRows = table.Column<long>(type: "bigint", nullable: false),
                    LastGapFromUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastGapToUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelemetryPersistenceCheckpoints", x => x.Stream);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TelemetryPersistenceCheckpoints");

            migrationBuilder.DropColumn(
                name: "AcquisitionOrdinal",
                table: "InaReadings");

            migrationBuilder.DropColumn(
                name: "SampleOrdinal",
                table: "TelemetryReadings");

            migrationBuilder.DropColumn(
                name: "AcquisitionOrdinal",
                table: "TelemetryReadings");
        }
    }
}
