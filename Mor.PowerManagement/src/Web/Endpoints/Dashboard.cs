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
using Microsoft.Extensions.Caching.Memory;

namespace Mor.PowerManagement.Web.Endpoints;

// Dashboard surface used by the React SPA (cookie auth, like the Todo endpoints).
public class Dashboard : IEndpointGroup
{
    private static class DashboardCacheKeys
    {
        public const string State = "dashboard:state";
    }

    // Testing rig: 5 wired channels (MUST_READ.md, until 31 Oct 2026).
    // Restore to 13 with the full rig.
    private const int MaxChannels = 5;

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
    public static async Task<Ok<DashboardStateVm>> GetState(ISender sender, IMemoryCache cache)
    {
        // The console polls this endpoint twice a second while the database is
        // cloud-hosted (~180 ms per round trip), so every poll paid a visible
        // lag. A 1 s absolute-expired cache means overlapping polls from the
        // dashboard and the inventory view share one query, and the worst case
        // staleness is one polling interval. Mutations (activation, shed,
        // thresholds) evict it immediately, so a button press never reads stale.
        var state = await cache.GetOrCreateAsync(
            DashboardCacheKeys.State,
            async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(1);
                return await sender.Send(new GetDashboardStateQuery());
            });

        return TypedResults.Ok(state);
    }

    [EndpointSummary("Get telemetry series")]
    [EndpointDescription(
        "Returns per-channel voltage, current and power time series for a bounded window (15m|1h|6h|24h|7d), " +
        "aggregated server-side into fixed time buckets (max 360 points per series). Each channel carries a " +
        "provenance label: the 220 V mains channels (CH1-CH4) report voltage from the INA226 on the mains " +
        "feed, and their current is measured on each channel's own ADS1015 input via its branch CT sensor; " +
        "the USB rail has no current sensor and reports its nominal rating. Empty buckets are returned as " +
        "null, never zero.")]
    // BadRequest<string> rather than bare BadRequest: the 400 body names the
    // valid values so a bad request is self-explanatory.
    public static async Task<Results<Ok<TelemetrySeriesVm>, BadRequest<string>>> GetTelemetry(
        ISender sender, IMemoryCache cache, string? window, string? channels)
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

        // Same reasoning as the state endpoint, but the aggregation queries are
        // heavier (they bucket thousands of rows), so the TTL follows the
        // window: short windows expire fast enough to track live load, long
        // ones barely change between polls.
        var cacheKey = $"dashboard:telemetry:{parsedWindow}:{string.Join(",", outletIds)}";
        var ttl = parsedWindow switch
        {
            TelemetryWindow.Minutes15 => TimeSpan.FromSeconds(2),
            TelemetryWindow.Hour1 => TimeSpan.FromSeconds(5),
            TelemetryWindow.Hours6 => TimeSpan.FromSeconds(30),
            _ => TimeSpan.FromMinutes(1),
        };

        var series = await cache.GetOrCreateAsync(
            cacheKey,
            async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = ttl;
                return await sender.Send(new GetTelemetrySeriesQuery
                {
                    Window = parsedWindow,
                    OutletIds = outletIds,
                });
            });

        return TypedResults.Ok(series);
    }

    // Accepts whitespace, duplicates and any order (E5); rejects anything
    // non-numeric, outside the rig's 1..5 channel range, or longer than the rig.
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

    [EndpointSummary("Get framework rules")]
    [EndpointDescription("Returns the FR-01..FR-12 event-condition-action framework rule repository, in precedence order.")]
    public static async Task<Ok<IReadOnlyList<ControlPolicyDto>>> GetPolicies(ISender sender)
    {
        var policies = await sender.Send(new GetPoliciesQuery());

        return TypedResults.Ok(policies);
    }

    [EndpointSummary("Request outlet activation")]
    [EndpointDescription("Runs the FR-04/FR-05 pre-activation assessment for an outlet and records the decision.")]
    public static async Task<Ok<OutletActivationResult>> RequestActivation(ISender sender, IMemoryCache cache, int id)
    {
        var result = await sender.Send(new RequestOutletActivationCommand { OutletId = id });
        cache.Remove(DashboardCacheKeys.State);

        return TypedResults.Ok(result);
    }

    [EndpointSummary("Disconnect an outlet")]
    [EndpointDescription("Opens the outlet relay and zeroes its live load (manual toggle-off path).")]
    public static async Task<Ok<int>> DisconnectOutlet(ISender sender, IMemoryCache cache, int id)
    {
        var outletId = await sender.Send(new DisconnectOutletCommand { OutletId = id });
        cache.Remove(DashboardCacheKeys.State);

        return TypedResults.Ok(outletId);
    }

    [EndpointSummary("Apply selective load response")]
    [EndpointDescription("Disconnects the lowest-priority energized outlets first (FR-07).")]
    public static async Task<Ok<SelectiveResponseResult>> ApplySelectiveResponse(ISender sender, IMemoryCache cache, ApplySelectiveResponseCommand? command)
    {
        var result = await sender.Send(command ?? new ApplySelectiveResponseCommand());
        cache.Remove(DashboardCacheKeys.State);

        return TypedResults.Ok(result);
    }

    [EndpointSummary("Update outlet policy")]
    [EndpointDescription("Updates priority, allowance, schedule or idle limit for an outlet. The ID in the URL must match the ID in the payload.")]
    public static async Task<Results<NoContent, BadRequest>> UpdateOutletPolicy(ISender sender, IMemoryCache cache, int id, UpdateOutletPolicyCommand command)
    {
        if (id != command.OutletId) return TypedResults.BadRequest();

        await sender.Send(command);
        cache.Remove(DashboardCacheKeys.State);

        return TypedResults.NoContent();
    }

    [EndpointSummary("Update system thresholds")]
    [EndpointDescription("Updates capacity, warning/critical limits and standby/idle tuning values.")]
    public static async Task<NoContent> UpdateThresholds(ISender sender, IMemoryCache cache, UpdateThresholdsCommand command)
    {
        await sender.Send(command);
        cache.Remove(DashboardCacheKeys.State);

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Defense-demo scenario ingest. Stores a telemetry batch through the same
    /// IngestTelemetry command the ESP32 uses, so the framework engine evaluates it
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
