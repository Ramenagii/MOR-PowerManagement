using Mor.PowerManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Mor.PowerManagement.Infrastructure.Data.Configurations;

public class ControlPolicyConfiguration : IEntityTypeConfiguration<ControlPolicy>
{
    public void Configure(EntityTypeBuilder<ControlPolicy> builder)
    {
        builder.HasIndex(p => p.Code).IsUnique();

        builder.Property(p => p.Code)
            .HasMaxLength(20)
            .IsRequired();

        builder.Property(p => p.Name)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(p => p.Condition)
            .HasMaxLength(500)
            .IsRequired();

        builder.Property(p => p.Action)
            .HasMaxLength(200)
            .IsRequired();
    }
}
