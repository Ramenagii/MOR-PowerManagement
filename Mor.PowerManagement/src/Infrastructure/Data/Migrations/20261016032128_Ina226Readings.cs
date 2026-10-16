using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Ina226Readings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "InaReadings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    BusVoltageV = table.Column<double>(type: "double precision", nullable: true),
                    ShuntVoltageMv = table.Column<double>(type: "double precision", nullable: true),
                    CurrentA = table.Column<double>(type: "double precision", nullable: true),
                    PowerW = table.Column<double>(type: "double precision", nullable: true),
                    Timestamp = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InaReadings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_InaReadings_Timestamp",
                table: "InaReadings",
                column: "Timestamp");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "InaReadings");
        }
    }
}
