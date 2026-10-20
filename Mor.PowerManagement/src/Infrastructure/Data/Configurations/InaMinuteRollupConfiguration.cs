using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class InaMinuteRollupConfiguration : IEntityTypeConfiguration<InaMinuteRollup>
{
    public void Configure(EntityTypeBuilder<InaMinuteRollup> builder)
    {
        // One INA226 per rig, so the bucket alone is the key (and the prune index).
        builder.HasKey(r => r.BucketStart);
    }
}
