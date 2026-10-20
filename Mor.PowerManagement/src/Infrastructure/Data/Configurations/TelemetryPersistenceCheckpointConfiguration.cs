using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class TelemetryPersistenceCheckpointConfiguration : IEntityTypeConfiguration<TelemetryPersistenceCheckpoint>
{
    public void Configure(EntityTypeBuilder<TelemetryPersistenceCheckpoint> builder)
    {
        // Two rows at most ("history", "live-state"); the stream name is the key.
        builder.HasKey(c => c.Stream);
        builder.Property(c => c.Stream).HasMaxLength(32);
    }
}
