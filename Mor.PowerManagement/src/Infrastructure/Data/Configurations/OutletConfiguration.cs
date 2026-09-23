using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class OutletConfiguration : IEntityTypeConfiguration<Outlet>
{
    public void Configure(EntityTypeBuilder<Outlet> builder)
    {
        builder.Property(o => o.Name)
            .HasMaxLength(100)
            .IsRequired();

        builder.Property(o => o.Role)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(o => o.MeterChannel)
            .HasMaxLength(100)
            .IsRequired();

        builder.Property(o => o.RelayChannel)
            .HasMaxLength(100)
            .IsRequired();

        builder.Property(o => o.Schedule)
            .HasMaxLength(200);

        builder.HasMany(o => o.Readings)
            .WithOne(r => r.Outlet)
            .HasForeignKey(r => r.OutletId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
