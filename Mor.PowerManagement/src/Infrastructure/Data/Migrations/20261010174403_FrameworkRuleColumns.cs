using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class FrameworkRuleColumns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Enabled",
                table: "ControlPolicies",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "LegacyCode",
                table: "ControlPolicies",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Precedence",
                table: "ControlPolicies",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "RuleFamily",
                table: "ControlPolicies",
                type: "text",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Enabled",
                table: "ControlPolicies");

            migrationBuilder.DropColumn(
                name: "LegacyCode",
                table: "ControlPolicies");

            migrationBuilder.DropColumn(
                name: "Precedence",
                table: "ControlPolicies");

            migrationBuilder.DropColumn(
                name: "RuleFamily",
                table: "ControlPolicies");
        }
    }
}
