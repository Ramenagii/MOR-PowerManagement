using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class FrameworkF1F4State : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "AutomaticPrioritisationEnabled",
                table: "PowerSystemConfigs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<long>(
                name: "LastAcquisitionSequence",
                table: "PowerSystemConfigs",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<Guid>(
                name: "LastAcquisitionSessionId",
                table: "PowerSystemConfigs",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "AutomaticRecoveryAttempts",
                table: "Outlets",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "CommandNeedsReview",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "FaultHold",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "IsProtected",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "ManualHold",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "NextRecoveryAtUtc",
                table: "Outlets",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PendingCommandAcknowledgedAtUtc",
                table: "Outlets",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "PendingCommandId",
                table: "Outlets",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PendingCommandIssuedAtUtc",
                table: "Outlets",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PendingCommandOrigin",
                table: "Outlets",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "PendingRelayClosed",
                table: "Outlets",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "RecoveryEpisodeId",
                table: "Outlets",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "RecoveryLockout",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "RecoveryTrialOverLimitBatches",
                table: "Outlets",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "RecoveryTrialPending",
                table: "Outlets",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AutomaticPrioritisationEnabled",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "LastAcquisitionSequence",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "LastAcquisitionSessionId",
                table: "PowerSystemConfigs");

            migrationBuilder.DropColumn(
                name: "AutomaticRecoveryAttempts",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "CommandNeedsReview",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "FaultHold",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "IsProtected",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "ManualHold",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "NextRecoveryAtUtc",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "PendingCommandAcknowledgedAtUtc",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "PendingCommandId",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "PendingCommandIssuedAtUtc",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "PendingCommandOrigin",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "PendingRelayClosed",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "RecoveryEpisodeId",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "RecoveryLockout",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "RecoveryTrialOverLimitBatches",
                table: "Outlets");

            migrationBuilder.DropColumn(
                name: "RecoveryTrialPending",
                table: "Outlets");
        }
    }
}
