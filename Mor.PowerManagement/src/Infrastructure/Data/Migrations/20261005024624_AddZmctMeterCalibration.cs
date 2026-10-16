using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddZmctMeterCalibration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "ZmctBurdenOhms",
                table: "PowerSystemConfigs",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<double>(
                name: "ZmctCtRatio",
                table: "PowerSystemConfigs",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<double>(
                name: "ZmctGain",
                table: "PowerSystemConfigs",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            migrationBuilder.AddColumn<double>(
                name: "ZmctPowerFactor",
                table: "PowerSystemConfigs",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ZmctBurdenOhms",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "ZmctCtRatio",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "ZmctGain",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "ZmctPowerFactor",
                table: "PowerSystemConfigs");
        }
    }
}
