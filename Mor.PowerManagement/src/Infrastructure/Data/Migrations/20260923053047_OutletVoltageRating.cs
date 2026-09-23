using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class OutletVoltageRating : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "RatedVoltageVolts",
                table: "Outlets",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "RatedVoltageVolts",
                table: "Outlets");
        }
    }
}
