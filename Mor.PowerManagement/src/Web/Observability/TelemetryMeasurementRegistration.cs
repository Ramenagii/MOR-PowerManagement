using Mor.PowerManagement.Infrastructure.Observability;
using OpenTelemetry.Metrics;

namespace Mor.PowerManagement.Web.Observability;

public static class TelemetryMeasurementRegistration
{
    public static void AddTelemetryRequestMeasurement(this WebApplicationBuilder builder)
    {
        if (!global::Mor.PowerManagement.Infrastructure.Observability.TelemetryMeasurementRegistration.MeasurementEnabled(builder.Configuration)) return;
        builder.Services.AddOpenTelemetry().WithMetrics(m => m.AddMeter(TelemetryDatabaseMetrics.MeterName));
    }

    public static void UseTelemetryRequestMeasurement(this WebApplication app)
    {
        if (global::Mor.PowerManagement.Infrastructure.Observability.TelemetryMeasurementRegistration.MeasurementEnabled(app.Configuration))
            app.UseMiddleware<TelemetryRequestMetricsMiddleware>();
    }
}
