using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class InaReadingConfiguration : IEntityTypeConfiguration<InaReading>
{
    public void Configure(EntityTypeBuilder<InaReading> builder)
    {
        // The dashboard reads the newest row, and retention scans by time. The
        // series is one row per batch (5 s on this rig), so it is small next to
        // TelemetryReadings - but it grows at the same rate, so it is pruned at
        // the same cutoff.
        builder.HasIndex(r => r.Timestamp);

        // Nullable because a sensor that reported only a current still has a row
        // to record; a NOT NULL 0 here would read as "measured zero" on the GUI.
        builder.Property(r => r.BusVoltageV);
        builder.Property(r => r.ShuntVoltageMv);
        builder.Property(r => r.CurrentA);
        builder.Property(r => r.PowerW);
    }
}