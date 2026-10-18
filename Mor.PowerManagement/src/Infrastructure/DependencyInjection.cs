using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Infrastructure.Data;
using Mor.PowerManagement.Infrastructure.Data.Interceptors;
using Mor.PowerManagement.Infrastructure.Identity;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Npgsql;

namespace Microsoft.Extensions.DependencyInjection;

public static class DependencyInjection
{
    public static void AddInfrastructureServices(this IHostApplicationBuilder builder)
    {
        var rawConnectionString = builder.Configuration.GetConnectionString(Services.Database);
        Guard.Against.NullOrWhiteSpace(rawConnectionString, message: $"Connection string '{Services.Database}' not found.");

        // Neon hands out URLs like postgresql://user:pass@host/db?sslmode=require;
        // Npgsql expects ADO.NET format, so normalise before handing it to EF Core.
        var connectionString = NormalizePostgresConnectionString(rawConnectionString, builder.Environment.IsProduction());

        builder.Services.AddScoped<ISaveChangesInterceptor, AuditableEntityInterceptor>();
        builder.Services.AddScoped<ISaveChangesInterceptor, DispatchDomainEventsInterceptor>();

        builder.Services.AddDbContext<ApplicationDbContext>((sp, options) =>
        {
            options.AddInterceptors(sp.GetServices<ISaveChangesInterceptor>());
            options.UseNpgsql(connectionString);
            options.ConfigureWarnings(warnings => warnings.Ignore(RelationalEventId.PendingModelChangesWarning));
        });

        builder.EnrichNpgsqlDbContext<ApplicationDbContext>();

        builder.Services.AddScoped<IApplicationDbContext>(provider => provider.GetRequiredService<ApplicationDbContext>());

        builder.Services.AddScoped<ApplicationDbContextInitialiser>();

        // Sign-in and authenticate MUST name the same scheme, or every
        // RequireAuthorization() endpoint rejects a perfectly valid cookie.
        //
        // With useCookies=true the sign-in below issues
        // .AspNetCore.Identity.Application (verified against a running host).
        // Setting DefaultAuthenticateScheme to the Bearer scheme here looked
        // reasonable but made authorization read .AspNetCore.Identity.Bearer,
        // which nothing ever issues -- so login returned 200, the cookie was
        // set, and every subsequent call to /Dashboard/* still returned 401.
        // The dashboard could therefore never load data and silently fell back
        // to its hardcoded offline roster, which is why the rig appeared to
        // have six outlets instead of thirteen.
        //
        // Both defaults are Application so sign-in and authorization agree.
        // The bearer-named cookie handler stays registered because
        // MapIdentityApi references it for its non-cookie flows.
        builder.Services.AddAuthentication(options =>
            {
                options.DefaultScheme = IdentityConstants.ApplicationScheme;
                options.DefaultSignInScheme = IdentityConstants.ApplicationScheme;
                options.DefaultAuthenticateScheme = IdentityConstants.ApplicationScheme;
                options.DefaultChallengeScheme = IdentityConstants.ApplicationScheme;
            })
            .AddIdentityCookies();

        // AddIdentityCookies() returns IdentityCookiesBuilder, so the bearer-named
        // scheme has to be registered through a separate AuthenticationBuilder.
        builder.Services.AddAuthentication()
            .AddCookie(IdentityConstants.BearerScheme);

        builder.Services.AddAuthorizationBuilder();

        builder.Services
            .AddIdentityCore<ApplicationUser>()
            .AddRoles<IdentityRole>()
            .AddEntityFrameworkStores<ApplicationDbContext>()
            .AddSignInManager()
            .AddDefaultTokenProviders()
            .AddApiEndpoints();

        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddTransient<IIdentityService, IdentityService>();

        // Bounds TelemetryReadings growth. Opportunistic, not scheduled: the job
        // only ticks while the host is awake.
        builder.Services.AddHostedService<TelemetryRetentionService>();
    }

    private static string NormalizePostgresConnectionString(string raw, bool requireTls)
    {
        if (!raw.Contains("://", StringComparison.Ordinal))
        {
            var native = new NpgsqlConnectionStringBuilder(raw);
            if (requireTls)
            {
                native.SslMode = SslMode.Require;
            }

            return native.ConnectionString;
        }

        var uri = new Uri(raw);

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.Trim('/')),
            SslMode = requireTls ? SslMode.Require : SslMode.Prefer,
        };

        var userInfo = uri.UserInfo.Split(':', 2);
        if (userInfo.Length > 0 && userInfo[0].Length > 0)
        {
            builder.Username = Uri.UnescapeDataString(userInfo[0]);
        }

        if (userInfo.Length > 1)
        {
            builder.Password = Uri.UnescapeDataString(userInfo[1]);
        }

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length != 2)
            {
                continue;
            }

            if (parts[0].Equals("sslmode", StringComparison.OrdinalIgnoreCase)
                && Enum.TryParse<SslMode>(parts[1], ignoreCase: true, out var sslMode))
            {
                builder.SslMode = sslMode;
            }
            else if (parts[0].Equals("channel_binding", StringComparison.OrdinalIgnoreCase)
                && Enum.TryParse<ChannelBinding>(parts[1], ignoreCase: true, out var channelBinding))
            {
                builder.ChannelBinding = channelBinding;
            }
        }

        return builder.ConnectionString;
    }
}
