using Mor.PowerManagement.Application.Power.Commands.ApplySelectiveResponse;
using Mor.PowerManagement.Application.Power.Commands.DisconnectOutlet;
using Mor.PowerManagement.Application.Power.Commands.RequestOutletActivation;
using Mor.PowerManagement.Application.Power.Commands.UpdateOutletPolicy;
using Mor.PowerManagement.Application.Power.Commands.UpdateThresholds;
using Mor.PowerManagement.Application.Power.Queries.GetDashboardState;
using Mor.PowerManagement.Application.Power.Queries.GetPolicies;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Mor.PowerManagement.Web.Endpoints;

// Dashboard surface used by the React SPA (cookie auth, like the Todo endpoints).
public class Dashboard : IEndpointGroup
{
    public static void Map(RouteGroupBuilder groupBuilder)
    {
        groupBuilder.RequireAuthorization();

        groupBuilder.MapGet(GetState, "state");
        groupBuilder.MapGet(GetPolicies, "policies");
        groupBuilder.MapPost(RequestActivation, "outlets/{id}/activation");
        groupBuilder.MapPost(DisconnectOutlet, "outlets/{id}/disconnection");
        groupBuilder.MapPost(ApplySelectiveResponse, "shedding/selective");
        groupBuilder.MapPut(UpdateOutletPolicy, "outlets/{id}/policy");
        groupBuilder.MapPut(UpdateThresholds, "thresholds");
    }

    [EndpointSummary("Get dashboard state")]
    [EndpointDescription("Returns outlets with live load, totals, system state, thresholds and recent events.")]
    public static async Task<Ok<DashboardStateVm>> GetState(ISender sender)
    {
        var state = await sender.Send(new GetDashboardStateQuery());

        return TypedResults.Ok(state);
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
}
