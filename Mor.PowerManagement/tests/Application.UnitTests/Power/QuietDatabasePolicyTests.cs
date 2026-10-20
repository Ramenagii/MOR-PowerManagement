using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Moq;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.History;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.UnitTests.Power.Characterization;
using Mor.PowerManagement.Application.UnitTests.Power.History;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Power;
using Mor.PowerManagement.Infrastructure.Power.History;
using Npgsql;
using NUnit.Framework;

namespace Mor.PowerManagement.Application.UnitTests.Power;

/// <summary>
/// PLAN-0001 Spec G policy. Nothing here connects to a database: every
/// connection string is synthetic and only parsed.
/// </summary>
public class QuietDatabasePolicyTests
{
    private const string SyntheticPassword = "synthetic-not-a-secret";
    private const string SyntheticKeyValue = "Host=quiet.invalid;Port=5432;Database=quiet;Username=quiet;Password=" + SyntheticPassword;
    private const string SyntheticUrl = "postgresql://quiet:" + SyntheticPassword + "@quiet.invalid/quiet?sslmode=require&channel_binding=require";

    private static readonly string[] RuntimeFlags =
    [
        PowerRuntimeOptions.CachedReadsEnabledKey,
        HistoryPersistenceOptions.RuntimeIngestEnabledKey,
        HistoryPersistenceOptions.BatchPersistenceEnabledKey,
    ];

    private static IEnumerable<TestCaseData> FlagCombinations()
    {
        for (var mask = 0; mask < 8; mask++)
        {
            yield return new TestCaseData((mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0);
        }
    }

    [Test]
    public void QuietDatabase_DefaultsOff()
    {
        var configuration = new ConfigurationBuilder().Build();
        Assert.That(QuietDatabaseOptions.FromConfiguration(configuration).Enabled, Is.False);
    }

    [TestCaseSource(nameof(FlagCombinations))]
    public void QuietDatabase_FlagOff_AcceptsEveryCombination(bool cached, bool ingest, bool batch)
    {
        Assert.DoesNotThrow(() => QuietDatabasePolicy.Validate(
            new QuietDatabaseOptions { Enabled = false },
            new PowerRuntimeOptions { CachedReadsEnabled = cached },
            new HistoryPersistenceOptions { RuntimeIngestEnabled = ingest, BatchPersistenceEnabled = batch }));
    }

    [TestCaseSource(nameof(FlagCombinations))]
    public void QuietDatabase_FlagOn_RequiresAllThreeRuntimeFlags(bool cached, bool ingest, bool batch)
    {
        void Validate() => QuietDatabasePolicy.Validate(
            new QuietDatabaseOptions { Enabled = true },
            new PowerRuntimeOptions { CachedReadsEnabled = cached },
            new HistoryPersistenceOptions { RuntimeIngestEnabled = ingest, BatchPersistenceEnabled = batch });

        if (cached && ingest && batch)
        {
            Assert.DoesNotThrow(Validate);
            return;
        }

        var error = Assert.Throws<InvalidOperationException>(Validate)!;
        Assert.That(error.Message, Does.Contain(QuietDatabaseOptions.QuietDatabaseModeKey));
        var enabled = new[] { cached, ingest, batch };
        for (var i = 0; i < RuntimeFlags.Length; i++)
        {
            Assert.That(error.Message.Contains(RuntimeFlags[i]), Is.EqualTo(!enabled[i]), RuntimeFlags[i]);
        }
    }

    [Test]
    public void QuietDatabase_StartupRejectsInvalidCombination_BeforeInfrastructureIsRegistered()
    {
        var builder = NewBuilder(new() { [QuietDatabaseOptions.QuietDatabaseModeKey] = "true", [PowerRuntimeOptions.CachedReadsEnabledKey] = "true" });
        var error = Assert.Throws<InvalidOperationException>(() => builder.AddQuietDatabase())!;
        Assert.That(error.Message, Does.Contain(HistoryPersistenceOptions.BatchPersistenceEnabledKey));
    }

    [Test]
    public void QuietDatabase_FlagOff_RegistersNothingElse()
    {
        var builder = NewBuilder(Flags(quiet: false));
        var quiet = builder.AddQuietDatabase();
        Assert.That(quiet.Enabled, Is.False);
        Assert.That(builder.Configuration[QuietDatabaseRegistration.AspireDisableHealthChecksKey], Is.Null);
        using var host = builder.Build();
        Assert.That(host.Services.GetRequiredService<IOptions<QuietDatabaseOptions>>().Value.Enabled, Is.False);
        Assert.That(host.Services.GetService<IOptions<HealthCheckServiceOptions>>()?.Value.Registrations ?? [], Is.Empty);
    }

    [Test]
    public void QuietDatabase_FlagOn_DisablesDatabaseHealthCheckAndRegistersInMemoryReadiness()
    {
        var builder = NewBuilder(Flags(quiet: true));
        Assert.That(builder.AddQuietDatabase().Enabled, Is.True);
        Assert.That(builder.Configuration[QuietDatabaseRegistration.AspireDisableHealthChecksKey], Is.EqualTo("true"));
        Assert.That(builder.Configuration[QuietDatabaseRegistration.AspireContextDisableHealthChecksKey], Is.EqualTo("true"));
        using var host = builder.Build();
        var registration = host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations.Single();
        Assert.That(registration.Name, Is.EqualTo(QuietRuntimeReadinessCheck.Name));
        Assert.That(registration.Tags, Is.EquivalentTo(new[] { QuietDatabaseRegistration.ReadyTag }));
    }

    [Test]
    public void QuietDatabase_ConnectionFindings_NpgsqlDefaultsAreQuiet()
    {
        Assert.That(QuietDatabasePolicy.ConnectionFindings(SyntheticKeyValue), Is.Empty);
    }

    [TestCase("Keepalive=30", "Keepalive")]
    [TestCase("Tcp Keepalive=true", "TCP Keepalive")]
    [TestCase("Minimum Pool Size=1", "Minimum Pool Size")]
    public void QuietDatabase_ConnectionFindings_RejectIdleTrafficSettings_WithoutPrintingValues(string setting, string finding)
    {
        var connectionString = SyntheticKeyValue + ";" + setting;
        Assert.That(QuietDatabasePolicy.ConnectionFindings(connectionString), Is.EqualTo(new[] { finding }));
        var error = Assert.Throws<InvalidOperationException>(() => QuietDatabasePolicy.EnsureConnectionString(connectionString))!;
        Assert.That(error.Message, Does.Contain(finding));
        Assert.That(error.Message, Does.Not.Contain(SyntheticPassword));
        Assert.That(error.Message, Does.Not.Contain("quiet.invalid"));
    }

    [Test]
    public void QuietDatabase_HealthChecks_OnlyInProcessChecksAndNoPublishers()
    {
        Assert.DoesNotThrow(() => QuietDatabasePolicy.EnsureHealthChecks(["self", QuietRuntimeReadinessCheck.Name], 0));
        var dbCheck = Assert.Throws<InvalidOperationException>(() => QuietDatabasePolicy.EnsureHealthChecks(["self", nameof(ApplicationDbContext)], 0))!;
        Assert.That(dbCheck.Message, Does.Contain(nameof(ApplicationDbContext)));
        Assert.Throws<InvalidOperationException>(() => QuietDatabasePolicy.EnsureHealthChecks(["self"], 1));
    }

    /// <summary>
    /// G-3: the effective EF connection string, after the production
    /// normalizer, carries no keepalive, TCP keepalive or pool minimum, in both
    /// the URL and key/value forms. GetConnectionString does not connect.
    /// </summary>
    [TestCase(SyntheticUrl, "Production")]
    [TestCase(SyntheticUrl, "Development")]
    [TestCase(SyntheticKeyValue, "Production")]
    [TestCase(SyntheticKeyValue, "Development")]
    public void QuietDatabase_G3_EffectiveConnectionStringHasNoIdleTraffic(string raw, string environment)
    {
        using var host = BuildInfrastructureHost(raw, environment, quiet: true);
        var effective = EffectiveConnectionString(host);
        var settings = new NpgsqlConnectionStringBuilder(effective);
        Assert.That(settings.KeepAlive, Is.Zero);
        Assert.That(settings.TcpKeepAlive, Is.False);
        Assert.That(settings.MinPoolSize, Is.Zero);
        Assert.That(settings.Pooling, Is.True);
        Assert.That(QuietDatabasePolicy.ConnectionFindings(effective), Is.Empty);
        Assert.DoesNotThrow(host.EnsureQuietDatabasePolicy);
    }

    [Test]
    public void QuietDatabase_G1_AspireDatabaseHealthCheckPresentWhenOff_AbsentWhenOn()
    {
        using (var off = BuildInfrastructureHost(SyntheticKeyValue, "Production", quiet: false))
        {
            var names = off.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations.Select(r => r.Name).ToList();
            Assert.That(names, Does.Contain(nameof(ApplicationDbContext)), "flag off keeps the Aspire DbContext check (unchanged behavior)");
            Assert.DoesNotThrow(off.EnsureQuietDatabasePolicy, "flag off: the policy is a no-op");
        }

        using var on = BuildInfrastructureHost(SyntheticKeyValue, "Production", quiet: true);
        var quietNames = on.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations.Select(r => r.Name).ToList();
        Assert.That(quietNames, Is.EquivalentTo(new[] { "self", QuietRuntimeReadinessCheck.Name }));
    }

    [Test]
    public void QuietDatabase_StartupRejectsKeepaliveConnectionString_WithoutPrintingIt()
    {
        using var host = BuildInfrastructureHost(SyntheticKeyValue + ";Keepalive=30", "Production", quiet: true);
        var error = Assert.Throws<InvalidOperationException>(host.EnsureQuietDatabasePolicy)!;
        Assert.That(error.Message, Does.Contain("Keepalive"));
        Assert.That(error.Message, Does.Not.Contain(SyntheticPassword));
    }

    [Test]
    public async Task QuietDatabase_Readiness_UnhealthyUntilHydratedAndInitialized_AndOnUnrecordedGap()
    {
        var store = new Mock<IPowerRuntimeStore>();
        store.SetupGet(s => s.Published).Returns((PowerRuntimeSnapshot?)null);
        var clock = new ControlledTimeProvider();
        var buffer = new BoundedHistoryBuffer(Options.Create(new HistoryPersistenceOptions { BatchPersistenceEnabled = true, MaxBufferedAcquisitions = 1 }), clock);
        var check = new QuietRuntimeReadinessCheck(store.Object, buffer);

        Assert.That((await check.CheckHealthAsync(new HealthCheckContext())).Status, Is.EqualTo(HealthStatus.Unhealthy), "not hydrated");

        store.SetupGet(s => s.Published).Returns(new PowerRuntimeSnapshot());
        Assert.That((await check.CheckHealthAsync(new HealthCheckContext())).Status, Is.EqualTo(HealthStatus.Unhealthy), "history not initialized");

        buffer.Initialize(0, 0, 0, 0);
        Assert.That((await check.CheckHealthAsync(new HealthCheckContext())).Status, Is.EqualTo(HealthStatus.Healthy));

        buffer.Accept(HistoryBufferTests.Sample(1, clock.Peek()));
        Assert.That(buffer.Accept(HistoryBufferTests.Sample(2, clock.Peek())), Is.EqualTo(HistoryAcceptance.Dropped));
        var gap = await check.CheckHealthAsync(new HealthCheckContext());
        Assert.That(gap.Status, Is.EqualTo(HealthStatus.Unhealthy), "an unrecorded gap is never hidden");
        Assert.That(gap.Data["totalDroppedAcquisitions"], Is.EqualTo(1L));
    }

    [Test]
    public async Task QuietDatabase_Readiness_RecordedGapFromCheckpointIsDegradedNotUnhealthy()
    {
        var store = new Mock<IPowerRuntimeStore>();
        store.SetupGet(s => s.Published).Returns(new PowerRuntimeSnapshot());
        var clock = new ControlledTimeProvider();
        var buffer = new BoundedHistoryBuffer(Options.Create(new HistoryPersistenceOptions { BatchPersistenceEnabled = true }), clock);
        // A gap restored from the history checkpoint at startup is already recorded.
        buffer.Initialize(10, 10, 10, 50, drops: 3, dropRows: 15, gapFrom: clock.Peek().AddHours(-1), gapTo: clock.Peek().AddMinutes(-59));
        var result = await new QuietRuntimeReadinessCheck(store.Object, buffer).CheckHealthAsync(new HealthCheckContext());
        Assert.That(result.Status, Is.EqualTo(HealthStatus.Degraded));
    }

    private static Dictionary<string, string?> Flags(bool quiet) => new()
    {
        [QuietDatabaseOptions.QuietDatabaseModeKey] = quiet ? "true" : "false",
        [PowerRuntimeOptions.CachedReadsEnabledKey] = "true",
        [HistoryPersistenceOptions.RuntimeIngestEnabledKey] = "true",
        [HistoryPersistenceOptions.BatchPersistenceEnabledKey] = "true",
    };

    private static HostApplicationBuilder NewBuilder(Dictionary<string, string?> values, string environment = "Development")
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings { DisableDefaults = true, EnvironmentName = environment });
        builder.Configuration.AddInMemoryCollection(values);
        return builder;
    }

    private static IHost BuildInfrastructureHost(string connectionString, string environment, bool quiet)
    {
        var values = Flags(quiet);
        values["ConnectionStrings:Mor.PowerManagementDb"] = connectionString;
        values[PowerRuntimeOptions.SingleWriterLockDirectoryKey] = Path.GetTempPath();
        var builder = NewBuilder(values, environment);
        builder.Services.AddLogging();
        builder.Services.AddHealthChecks().AddCheck("self", () => HealthCheckResult.Healthy(), [QuietDatabaseRegistration.LiveTag]);
        builder.AddQuietDatabase();
        builder.AddApplicationServices();
        builder.AddInfrastructureServices();
        builder.Services.AddScoped<IUser, NoUser>();
        return builder.Build();
    }

    private static string EffectiveConnectionString(IHost host)
    {
        using var scope = host.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetConnectionString()!;
    }

    private sealed class NoUser : IUser
    {
        public string? Id => null;

        public List<string>? Roles => null;
    }
}
