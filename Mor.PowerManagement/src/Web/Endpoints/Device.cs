using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Queries.GetDeviceConfig;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Mor.PowerManagement.Web.Endpoints;

// ESP32 edge-device surface: telemetry ingest + config sync.
// Authenticated with the X-Device-Key shared secret (see DeviceApiKeyEndpointFilter),
// not the dashboard cookie scheme.
public class Device : IEndpointGroup
{
    public static void Map(RouteGroupBuilder groupBuilder)
    {
        groupBuilder.AllowAnonymous();
        groupBuilder.AddEndpointFilter<DeviceApiKeyEndpointFilter>();

        groupBuilder.MapPost(IngestTelemetry, "telemetry");
        groupBuilder.MapGet(GetDeviceConfig, "config");
    }

    [EndpointSummary("Ingest ESP32 telemetry")]
    [EndpointDescription("Stores per-outlet PZEM readings, refreshes live outlet state, and evaluates threshold crossings and fault lockout.")]
    public static async Task<Ok<IngestTelemetryResult>> IngestTelemetry(ISender sender, IngestTelemetryCommand command)
    {
        var result = await sender.Send(command);

        return TypedResults.Ok(result);
    }

    [EndpointSummary("Get device configuration")]
    [EndpointDescription("Returns thresholds and the outlet policy table so the ESP32 can synchronize before evaluating POL-01..POL-08 locally.")]
    public static async Task<Ok<DeviceConfigVm>> GetDeviceConfig(ISender sender)
    {
        var config = await sender.Send(new GetDeviceConfigQuery());

        return TypedResults.Ok(config);
    }
}
