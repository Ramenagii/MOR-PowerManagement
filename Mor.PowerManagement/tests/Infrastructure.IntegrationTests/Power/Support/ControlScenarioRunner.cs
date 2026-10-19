using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Services;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Domain.Enums;
using Mor.PowerManagement.Domain.Services;
using Mor.PowerManagement.Infrastructure.Data;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

/// <summary>Reusable baseline adapter. Each action uses a fresh context, then reads
/// committed state back through another context. No host, seeder or wall-clock waits.</summary>
public sealed partial class ControlScenarioRunner(PostgresFixture database)
{
    private readonly Dictionary<string, string> _identities = new(StringComparer.OrdinalIgnoreCase);
    public ControlledTimeProvider Clock { get; } = new();
    public LoadSheddingStateStore Framework { get; } = new();
    public Guid Session { get; } = Guid.Parse("11111111-1111-1111-1111-111111111111");
    public long Sequence { get; private set; }
    public List<string> Traces { get; } = new();

    public async Task SeedAsync()
    {
        await database.ResetAsync();
        await using var db = database.CreateMigrationContext();
        db.PowerSystemConfigs.Add(new PowerSystemConfig());
        db.Outlets.AddRange(Enumerable.Range(1, 5).Select(id => new Outlet
        {
            Id = id, Name = $"Outlet {id}", Status = OutletStatus.Active,
            AllowanceWatts = 2000, CurrentWatts = 0, LastSeen = Clock.Peek(),
            RelayChannel = id == 5 ? "INA226 monitor" : $"relay-{id}",
        }));
        await db.SaveChangesAsync();
    }

    public IngestTelemetryCommand Sample(double watts = 100) => new()
    {
        AcquisitionSessionId = Session, AcquisitionSequence = ++Sequence,
        Readings = Enumerable.Range(1, 5).Select(id => new TelemetrySample
        {
            OutletId = id, PowerWatts = id == 1 ? watts : 0,
            Voltage = 238, CurrentAmps = id == 1 ? watts / 238 : 0, EnergyKwh = 12.345,
        }).ToList(),
    };

    public Task<IngestTelemetryResult> IngestAsync(IngestTelemetryCommand command)
        => ActAsync("ingest", db => new IngestTelemetryCommandHandler(db, Framework, Clock).Handle(command, CancellationToken.None), command);

    public async Task<T> ActAsync<T>(string label, Func<ApplicationDbContext, Task<T>> action, object? input = null)
    {
        T result;
        await using (var db = database.CreateMigrationContext()) result = await action(db);
        Traces.Add(await TraceAsync(label, result, input));
        return result;
    }

    public async Task EditAsync(Action<List<Outlet>, PowerSystemConfig> edit)
    {
        await using var db = database.CreateMigrationContext();
        edit(await db.Outlets.OrderBy(x => x.Id).ToListAsync(), await db.PowerSystemConfigs.SingleAsync());
        await db.SaveChangesAsync();
    }

    public async Task<List<Outlet>> OutletsAsync()
    {
        await using var db = database.CreateMigrationContext();
        return await db.Outlets.AsNoTracking().OrderBy(x => x.Id).ToListAsync();
    }

    public async Task<List<PowerEvent>> EventsAsync()
    {
        await using var db = database.CreateMigrationContext();
        return await db.PowerEvents.AsNoTracking().OrderBy(x => x.Id).ToListAsync();
    }

    public async Task<string> TraceAsync(string label, object? result, object? input = null)
    {
        await using var db = database.CreateMigrationContext();
        var outlets = await db.Outlets.AsNoTracking().OrderBy(x => x.Id).ToListAsync();
        var trace = JsonSerializer.Serialize(new
        {
            label, time = Clock.Peek(), input, result, framework = Framework.Current,
            outlets = outlets.Select(o => new
            {
                o.Id, o.Status, o.CurrentWatts, o.LastSeen, o.CommandedAtUtc,
                o.ManualHold, o.FaultHold, o.RecoveryLockout, o.AutomaticRecoveryAttempts,
                o.RecoveryEpisodeId, o.NextRecoveryAtUtc, o.RecoveryTrialPending, o.RecoveryTrialOverLimitBatches,
                o.PendingCommandId, o.PendingRelayClosed, o.PendingCommandOrigin,
                o.PendingCommandIssuedAtUtc, o.PendingCommandAcknowledgedAtUtc, o.CommandNeedsReview,
            }),
            config = await db.PowerSystemConfigs.AsNoTracking().SingleAsync(),
            events = (await db.PowerEvents.AsNoTracking().OrderBy(x => x.Id).ToListAsync())
                .Select(e => new { e.Id, e.Timestamp, e.Title, e.Detail, e.Severity }),
            telemetry = await db.TelemetryReadings.CountAsync(), ina = await db.InaReadings.CountAsync(),
        });
        // One mapping for the complete run, including IDs embedded in event detail.
        return GuidPattern().Replace(trace, m =>
        {
            if (!_identities.TryGetValue(m.Value, out var symbolic))
                _identities[m.Value] = symbolic = $"guid-{_identities.Count + 1}";
            return symbolic;
        });
    }

    [GeneratedRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")]
    private static partial Regex GuidPattern();
}
