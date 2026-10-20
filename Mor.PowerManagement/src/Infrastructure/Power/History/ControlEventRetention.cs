using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.Power.History;

/// <summary>
/// Ages control/audit events out after 30 days (approved revision B: every
/// event is stored individually for at least 30 days), always keeping the
/// newest <see cref="RetentionV2Options.RecentEventFloor"/>.
///
/// Unresolved operational state is never held in a PowerEvent: holds,
/// pending or unacknowledged relay commands and active recovery live on the
/// Outlets and PowerSystemConfigs rows, which this job never touches. Every
/// PowerEvent is a closed log entry, so none is exempt by state.
/// </summary>
public sealed class ControlEventRetention(IServiceScopeFactory scopes, RetentionV2Options options, TimeProvider clock)
{
    public static DateTimeOffset Cutoff(DateTimeOffset now) => now - RetentionV2Options.SummaryRetention;

    public async Task<(long Rows, bool Complete)> PruneAsync(DateTimeOffset now, DateTimeOffset deadlineUtc, CancellationToken cancellationToken)
    {
        var cutoff = Cutoff(now);
        var limit = options.PruneBatchRows;
        var floor = RetentionV2Options.RecentEventFloor;
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        long rows = 0;
        for (var batches = 0; batches < options.MaxBatchesPerRun; batches++)
        {
            if (clock.GetUtcNow() >= deadlineUtc) return (rows, false);
            cancellationToken.ThrowIfCancellationRequested();
            var deleted = await db.Database.ExecuteSqlInterpolatedAsync($"""
                WITH newest AS (
                    SELECT "Id" FROM "PowerEvents"
                    ORDER BY "Timestamp" DESC, "Id" DESC
                    LIMIT {floor}
                ), doomed AS (
                    SELECT "Id" FROM "PowerEvents"
                    WHERE "Timestamp" < {cutoff}
                      AND "Id" NOT IN (SELECT "Id" FROM newest)
                    ORDER BY "Timestamp", "Id"
                    LIMIT {limit}
                )
                DELETE FROM "PowerEvents" e USING doomed d WHERE e."Id" = d."Id"
                """, cancellationToken);
            rows += deleted;
            if (deleted < limit) return (rows, true);
        }

        return (rows, false);
    }
}
