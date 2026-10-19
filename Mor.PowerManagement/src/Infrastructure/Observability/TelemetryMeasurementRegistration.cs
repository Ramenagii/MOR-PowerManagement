using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Mor.PowerManagement.Infrastructure.Observability;

public static class TelemetryMeasurementRegistration
{
    public static bool MeasurementEnabled(IConfiguration configuration)
        => configuration.GetValue<bool>("Telemetry:Measurement:Enabled");

    public static IServiceCollection AddTelemetryMeasurement(this IServiceCollection services, IConfiguration configuration)
    {
        if (!MeasurementEnabled(configuration)) return services;
        services.AddSingleton<TelemetryDatabaseMetrics>();
        services.AddSingleton<TelemetryDatabaseInterceptor>();
        services.AddSingleton<TelemetryConnectionInterceptor>();
        return services;
    }

    public static void AddTelemetryMeasurementInterceptors(this DbContextOptionsBuilder options, IServiceProvider services)
    {
        if (services.GetService<TelemetryDatabaseInterceptor>() is not { } interceptor) return;
        options.AddInterceptors(interceptor, services.GetRequiredService<TelemetryConnectionInterceptor>());
        options.LogTo(_ => services.GetRequiredService<TelemetryDatabaseMetrics>().RecordRetry(),
            [Microsoft.EntityFrameworkCore.Diagnostics.CoreEventId.ExecutionStrategyRetrying]);
    }
}
