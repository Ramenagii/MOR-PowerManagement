using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class TelemetryReadingConfiguration : IEntityTypeConfiguration<TelemetryReading>
{
    public void Configure(EntityTypeBuilder<TelemetryReading> builder)
    {
        // Single-channel deep dives and the FK cascade.
        builder.HasIndex(r => new { r.OutletId, r.Timestamp });

        // Range scans for the telemetry graph. The table is append-only and
        // Timestamp is physically monotonic, so BRIN correlation is ~1.0 and a
        // tiny index prunes almost everything.
        //
        // pages_per_range = 32 is NOT expressible here: EF Core 10's fluent API
        // has no HasPagesPerRange. The index IS still declared on the model, so
        // it does appear in ApplicationDbContextModelSnapshot (as brin, with the
        // default pages_per_range) and EF will not try to create it twice. The
        // only divergence between model and database is that storage parameter,
        // which EF never reconciles. The index itself is created with raw SQL in
        // TelemetrySeriesSupport.
        builder.HasIndex(r => r.Timestamp)
            .HasMethod("brin")
            .HasDatabaseName("IX_TelemetryReadings_Timestamp_brin");
    }
}
