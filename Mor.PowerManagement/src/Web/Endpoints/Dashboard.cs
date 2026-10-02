using Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;
using Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;
using Mor.PowerManagement.Application.Power.Commands.IngestTelemetry;
using Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;
using Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;
using Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;
using Mor.PowerManagement.Application.Power.Queries.GetDashboardState;
using Mor.PowerManagement.Application.Power.Queries.GetPolicies;
using Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Mor.PowerManagement.Web.Endpoints;

// Dashboard surface used by the React SPA (cookie auth, like the Todo endpoints).
public class Dashboard : IEndpointGroup
{
    private const int MaxChannels = 13;

    public static void Map(RouteGroupBuilder groupBuilder)
    {
        groupBuilder.RequireAuthorization();

        groupBuilder.MapGet(GetState, "state");
        groupBuilder.MapGet(GetTelemetry, "telemetry");
        groupBuilder.MapGet(GetPolicies, "policies");
        groupBuilder.MapPost(RequestActivation, "outlets/{id}/activation");
        groupBuilder.MapPost(DisconnectOutlet, "outlets/{id}/disconnection");
        groupBuilder.MapPost(ApplySelectiveResponse, "shedding/selective");
        groupBuilder.MapPut(UpdateOutletPolicy, "outlets/{id}/policy");
        groupBuilder.MapPut(UpdateThresholds, "thresholds");
        groupBuilder.MapPost(IngestScenario, "scenarios/ingest");
    }

    [EndpointSummary("Get dashboard state")]
    [EndpointDescription("Returns outlets with live load, totals, system state, thresholds and recent events.")]
    public static async Task<Ok<DashboardStateVm>> GetState(ISender sender)
    {
        var state = await sender.Send(new GetDashboardStateQuery());

        return TypedResults.Ok(state);
    }

    [EndpointSummary("Get telemetry series")]
    [EndpointDescription(
        "Returns per-channel voltage, current and power time series for a bounded window (15m|1h|6h|24h|7d), " +
        "aggregated server-side into fixed time buckets (max 360 points per series). Each channel carries a " +
        "provenance label: only CH1-CH8 voltage is ever metered, from the single mains PZEM-004T on the common " +
        "feed; per-channel current and power are derived by distributing the mains total across energized " +
        "channels weighted by allowance. Empty buckets are returned as null, never zero.")]
    // BadRequest<string> rather than bare BadRequest: the 400 body names the
    // valid values so a bad request is self-explanatory.
    public static async Task<Results<Ok<TelemetrySeriesVm>, BadRequest<string>>> GetTelemetry(
        ISender sender, string? window, string? channels)
    {
        // Validated before dispatch so a bad window surfaces as a plain 400
        // rather than a ValidationException through the exception handler.
        if (!GetTelemetrySeriesQuery.TryParseWindow(window, out var parsedWindow))
        {
            return TypedResults.BadRequest($"window must be one of: {GetTelemetrySeriesQuery.ValidWindowValues}.");
        }

        IReadOnlyList<int> outletIds = Array.Empty<int>();

        if (!string.IsNullOrEmpty(channels))
        {
            if (!TryParseChannels(channels, out outletIds, out var channelError))
            {
                return TypedResults.BadRequest(channelError);
            }
        }

        var series = await sender.Send(new GetTelemetrySeriesQuery
        {
            Window = parsedWindow,
            OutletIds = outletIds,
        });

        return TypedResults.Ok(series);
    }

    // Accepts whitespace, duplicates and any order (E5); rejects anything
    // non-numeric, out of the 1..13 rig range, or longer than the rig.
    private static bool TryParseChannels(string value, out IReadOnlyList<int> ids, out string error)
    {
        ids = Array.Empty<int>();
        error = string.Empty;

        var parts = value.Split(',');
        var parsed = new List<int>(parts.Length);

        foreach (var part in parts)
        {
            var trimmed = part.Trim();

            if (!int.TryParse(trimmed, out var id))
            {
                error = $"channels must be a comma-separated list of outlet ids 1..{MaxChannels}.";
                return false;
            }

            if (id < 1 || id > MaxChannels)
            {
                error = $"channels must be a comma-separated list of outlet ids 1..{MaxChannels}.";
                return false;
            }

            parsed.Add(id);
        }

        if (parsed.Count == 0)
        {
            error = $"channels must name at least one outlet id in 1..{MaxChannels}.";
            return false;
        }

        ids = parsed.Distinct().OrderBy(id => id).ToList();
        return true;
    }

    [EndpointSummary("Get control policies")]
    [EndpointDescription("Returns the POL-01..POL-08 event-condition-action policy repository.")]
    public static async Task<Ok<IReadOnlyList<ControlPolicyDto>>> GetPolicies(ISender sender)
    {
        var policies = await sender.Send(new GetPoliciesQuery());

        return TypedResults.Ok(policies);
    }

    [EndpointSummary("Request outlet activation")]
    [EndpointDescription("Runs the POL-02/POL-03 pre-activation assessment for an outlet and records the decision.")]
    public static async Task<Ok<OutletActivationResult>> RequestActivation(ISender sender, int id)
    {
        var result = await sender.Send(new RequestOutletActivationCommand { OutletId = id });

        return TypedResults.Ok(result);
    }

    [EndpointSummary("Disconnect an outlet")]
    [EndpointDescription("Opens the outlet relay and zeroes its live load (manual toggle-off path).")]
    public static async Task<Ok<int>> DisconnectOutlet(ISender sender, int id)
    {
        var outletId = await sender.Send(new DisconnectOutletCommand { OutletId = id });

        return TypedResults.Ok(outletId);
    }

    [EndpointSummary("Apply selective load response")]
    [EndpointDescription("Disconnects the lowest-priority energized outlets first (POL-05).")]
    public static async Task<Ok<SelectiveResponseResult>> ApplySelectiveResponse(ISender sender, ApplySelectiveResponseCommand? command)
    {
        var result = await sender.Send(command ?? new ApplySelectiveResponseCommand());

        return TypedResults.Ok(result);
    }

    [EndpointSummary("Update outlet policy")]
    [EndpointDescription("Updates priority, allowance, schedule or idle limit for an outlet. The ID in the URL must match the ID in the payload.")]
    public static async Task<Results<NoContent, BadRequest>> UpdateOutletPolicy(ISender sender, int id, UpdateOutletPolicyCommand command)
    {
        if (id != command.OutletId) return TypedResults.BadRequest();

        await sender.Send(command);

        return TypedResults.NoContent();
    }

    [EndpointSummary("Update system thresholds")]
    [EndpointDescription("Updates capacity, warning/critical limits and standby/idle tuning values.")]
    public static async Task<NoContent> UpdateThresholds(ISender sender, UpdateThresholdsCommand command)
    {
        await sender.Send(command);

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Defense-demo scenario ingest. Stores a telemetry batch through the same
    /// IngestTelemetry command the ESP32 uses, so the policy engine evaluates it
    /// and the resulting events are genuine rather than written by the browser.
    ///
    /// This exists because /api/Device/telemetry is gated on the X-Device-Key
    /// shared secret, which the SPA must not hold: anyone who could read the
    /// bundled JavaScript could then inject readings. This route uses the normal
    /// dashboard cookie instead, so the demo works on a host that has
    /// Device:ApiKey configured without ever shipping that key to the client.
    ///
    /// meteringMode is deliberately forced to Simulated. A demo batch is
    /// synthesised, and letting the caller assert otherwise would let a
    /// demonstration relabel itself as measured data.
    /// </summary>
    [EndpointSummary("Ingest a defense-demo telemetry batch")]
    [EndpointDescription(
        "Stores a scenario telemetry batch and returns the policy engine's own result: rows stored, " +
        "aggregate watts, resulting system state and the events it raised. Metering mode is forced to " +
        "Simulated because the batch is synthesised.")]
    public static async Task<Results<Ok<IngestTelemetryResult>, BadRequest>> IngestScenario(
        ISender sender,
        IngestTelemetryCommand command)
    {
        var result = await sender.Send(command with
        {
            DeviceId = command.DeviceId ?? "dashboard-scenario",
            MeteringMode = Domain.Enums.MeteringMode.Simulated,
        });

        return TypedResults.Ok(result);
    }
}
