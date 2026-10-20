using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class TelemetryCompactionCheckpointConfiguration : IEntityTypeConfiguration<TelemetryCompactionCheckpoint>
{
    public void Configure(EntityTypeBuilder<TelemetryCompactionCheckpoint> builder)
    {
        // Two rows at most ("telemetry", "ina"); the stream name is the key.
        builder.HasKey(c => c.Stream);
        builder.Property(c => c.Stream).HasMaxLength(32);
    }
}
