using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mor.PowerManagement.Infrastructure.Data.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261019030000_TelemetryRollups")]
public sealed class TelemetryRollups : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            CREATE TABLE "TelemetryReadingRollups" (
                "OutletId" integer NOT NULL REFERENCES "Outlets" ("Id") ON DELETE CASCADE,
                "BucketStart" timestamp with time zone NOT NULL,
                "SampleCount" bigint NOT NULL,
                "VoltageSum" double precision NOT NULL,
                "CurrentAmpsSum" double precision NOT NULL,
                "PowerWattsSum" double precision NOT NULL,
                "MinVoltage" double precision NOT NULL,
                "MaxVoltage" double precision NOT NULL,
                "PeakPowerWatts" double precision NOT NULL,
                "FirstEnergyKwh" double precision NOT NULL,
                "FirstSampleAt" timestamp with time zone NOT NULL,
                "LastEnergyKwh" double precision NOT NULL,
                "LatestSampleAt" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_TelemetryReadingRollups" PRIMARY KEY ("OutletId", "BucketStart")
            );

            CREATE INDEX "IX_TelemetryReadingRollups_BucketStart"
                ON "TelemetryReadingRollups" ("BucketStart");
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("DROP TABLE IF EXISTS \"TelemetryReadingRollups\";");
    }
}
