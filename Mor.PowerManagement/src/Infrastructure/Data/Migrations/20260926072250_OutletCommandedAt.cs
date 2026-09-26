using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class OutletCommandedAt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CommandedAtUtc",
                table: "Outlets",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CommandedAtUtc",
                table: "Outlets");
        }
    }
}
