using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Domain.Entities;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Power.History;

namespace Mor.PowerManagement.Infrastructure.IntegrationTests.Power.Support;

/// <summary>
/// Host for PLAN-0001 Spec F retention tests: the real Application and
/// Infrastructure registrations against an isolated schema, with
/// Telemetry:RetentionV2Enabled and optional extra settings. Time is the
/// scenario's <see cref="ControlledTimeProvider"/>; nothing reads the wall clock.
/// </summary>
internal sealed class RetentionRig : IAsyncDisposable
{
    public required PostgresFixture Database { get; init; }
    public required ControlScenarioRunner Run { get; init; }
    public required IHost App { get; init; }
    public BatchWindowCoordinator Coordinator => App.Services.GetRequiredService<BatchWindowCoordinator>();
    public TelemetryCompactionRunner Compaction => App.Services.GetRequiredService<TelemetryCompactionRunner>();
    public ControlEventRetention Events => App.Services.GetRequiredService<ControlEventRetention>();
    public RetentionV2Options Options => App.Services.GetRequiredService<RetentionV2Options>();
    public DateTimeOffset Now => Run.Clock.Peek();

    public static async Task<RetentionRig> Create(bool v2 = true, IInterceptor? interceptor = null, IDictionary<string, string?>? settings = null)
    {
        var db = await PostgresFixture.CreateAsync();
        try
        {
            var run = new ControlScenarioRunner(db);
            await run.SeedAsync();
            var host = BuildHost(db, run, v2, interceptor, settings);
            return new RetentionRig { Database = db, Run = run, App = host };
        }
        catch
        {
            await db.DisposeAsync();
            throw;
        }
    }

    public static IHost BuildHost(PostgresFixture db, ControlScenarioRunner run, bool v2, IInterceptor? interceptor = null,
        IDictionary<string, string?>? settings = null, bool runtime = true, bool batched = true)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { DisableDefaults = true, EnvironmentName = "Development" });
        var config = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Mor.PowerManagementDb"] = db.ConnectionString,
            ["Telemetry:CachedReadsEnabled"] = runtime.ToString(),
            ["Telemetry:RuntimeIngestEnabled"] = runtime.ToString(),
            ["Telemetry:BatchPersistenceEnabled"] = batched.ToString(),
            [RetentionV2Options.EnabledKey] = v2.ToString(),
        };
        foreach (var (key, value) in settings ?? new Dictionary<string, string?>()) config[key] = value;
        builder.Configuration.AddInMemoryCollection(config);
        builder.Services.AddLogging();
        builder.AddApplicationServices();
        builder.AddInfrastructureServices();
        if (interceptor is not null) builder.Services.AddDbContext<ApplicationDbContext>((_, o) => o.AddInterceptors(interceptor));
        builder.Services.AddSingleton<TimeProvider>(run.Clock);
        builder.Services.AddScoped<IUser, NoUser>();
        builder.Services.AddScoped<ICurrentUserName>(_ => new ClaimsCurrentUserName(() => null));
        builder.Services.AddSingleton(run.Framework);
        return builder.Build();
    }

    public async Task AddReadingsAsync(params TelemetryReading[] readings)
    {
        await using var db = Database.CreateMigrationContext();
        db.TelemetryReadings.AddRange(readings);
        await db.SaveChangesAsync();
    }

    public async Task AddInaAsync(params InaReading[] readings)
    {
        await using var db = Database.CreateMigrationContext();
        db.InaReadings.AddRange(readings);
        await db.SaveChangesAsync();
    }

    public async Task AddEventsAsync(params DateTimeOffset[] timestamps)
    {
        await using var db = Database.CreateMigrationContext();
        db.PowerEvents.AddRange(timestamps.Select((t, i) => new PowerEvent { Timestamp = t, Title = $"event {i}", Detail = "retention test" }));
        await db.SaveChangesAsync();
    }

    public static TelemetryReading Reading(int outlet, DateTimeOffset at, double watts, double energy, double volts = 230, double amps = 1, long? acquisition = null, short? sample = null)
        => new() { OutletId = outlet, Timestamp = at, PowerWatts = watts, EnergyKwh = energy, Voltage = volts, CurrentAmps = amps, AcquisitionOrdinal = acquisition, SampleOrdinal = sample };

    public async Task<FiveMinuteRollup[]> FiveMinuteRollupsAsync()
    {
        await using var db = Database.CreateMigrationContext();
        return (await db.Database.SqlQuery<FiveMinuteRollup>($"""
            SELECT "OutletId", "BucketStart", "SampleCount", "VoltageSum", "CurrentAmpsSum", "PowerWattsSum",
                   "MinVoltage", "MaxVoltage", "PeakPowerWatts", "FirstEnergyKwh", "FirstSampleAt", "LastEnergyKwh", "LatestSampleAt"
            FROM "TelemetryReadingRollups"
            """).ToListAsync()).OrderBy(r => r.OutletId).ThenBy(r => r.BucketStart).ToArray();
    }

    public async ValueTask DisposeAsync()
    {
        App.Dispose();
        await Database.DisposeAsync();
    }

    private sealed class NoUser : IUser
    {
        public string? Id => null;
        public List<string>? Roles => null;
    }
}

/// <summary>Row of the raw-SQL five-minute rollup table (not an EF entity).</summary>
internal sealed record FiveMinuteRollup(int OutletId, DateTimeOffset BucketStart, long SampleCount, double VoltageSum, double CurrentAmpsSum,
    double PowerWattsSum, double MinVoltage, double MaxVoltage, double PeakPowerWatts, double FirstEnergyKwh, DateTimeOffset FirstSampleAt,
    double LastEnergyKwh, DateTimeOffset LatestSampleAt);
