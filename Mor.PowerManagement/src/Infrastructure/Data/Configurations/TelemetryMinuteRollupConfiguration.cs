using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class TelemetryMinuteRollupConfiguration : IEntityTypeConfiguration<TelemetryMinuteRollup>
{
    public void Configure(EntityTypeBuilder<TelemetryMinuteRollup> builder)
    {
        builder.HasKey(r => new { r.OutletId, r.BucketStart });

        // Pruning at day 30 scans by bucket time across outlets.
        builder.HasIndex(r => r.BucketStart);

        // Restrict, not cascade: deleting an outlet must never silently delete
        // its retained history (PLAN-0001 Spec F).
        builder.HasOne<Outlet>()
            .WithMany()
            .HasForeignKey(r => r.OutletId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
