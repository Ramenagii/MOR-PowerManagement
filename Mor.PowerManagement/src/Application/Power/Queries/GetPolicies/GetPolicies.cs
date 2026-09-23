using Mor.PowerManagement.Application.Common.Interfaces;

namespace Mor.PowerManagement.Application.Power.Queries.GetPolicies;

// The POL-01..POL-08 policy repository shown in the dashboard policies view.
public record GetPoliciesQuery : IRequest<IReadOnlyList<ControlPolicyDto>>;

public record ControlPolicyDto(
    int Id,
    string Code,
    string Name,
    string Condition,
    string Action);

public class GetPoliciesQueryHandler : IRequestHandler<GetPoliciesQuery, IReadOnlyList<ControlPolicyDto>>
{
    private readonly IApplicationDbContext _context;

    public GetPoliciesQueryHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<IReadOnlyList<ControlPolicyDto>> Handle(GetPoliciesQuery request, CancellationToken cancellationToken)
        => await _context.ControlPolicies
            .OrderBy(p => p.Code)
            .Select(p => new ControlPolicyDto(p.Id, p.Code, p.Name, p.Condition, p.Action))
            .ToListAsync(cancellationToken);
}
