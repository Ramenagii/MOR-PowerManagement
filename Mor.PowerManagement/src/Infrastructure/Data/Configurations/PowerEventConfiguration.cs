using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class PowerEventConfiguration : IEntityTypeConfiguration<PowerEvent>
{
    public void Configure(EntityTypeBuilder<PowerEvent> builder)
    {
        builder.HasIndex(e => e.Timestamp);

        builder.Property(e => e.Title)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(e => e.Detail)
            .HasMaxLength(1000);
    }
}
