using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class TelemetryReadingConfiguration : IEntityTypeConfiguration<TelemetryReading>
{
    public void Configure(EntityTypeBuilder<TelemetryReading> builder)
    {
        builder.HasIndex(r => new { r.OutletId, r.Timestamp });
    }
}
