using Mor.PowerManagement.Application.Common.Interfaces;

namespace Mor.PowerManagement.Application.Power.Queries.GetPolicies;

// The FR-01..FR-12 framework rule repository shown in the dashboard
// framework (policies) view. Ordered by precedence, not alphabetically,
// because precedence is the conflict-resolution order the ECA loop uses.
public record GetPoliciesQuery : IRequest<IReadOnlyList<ControlPolicyDto>>;

public record ControlPolicyDto(
    int Id,
    string Code,
    string Name,
    string Condition,
    string Action,
    string? LegacyCode,
    string RuleFamily,
    int Precedence,
    bool Enabled);

public class GetPoliciesQueryHandler : IRequestHandler<GetPoliciesQuery, IReadOnlyList<ControlPolicyDto>>
{
    private readonly IApplicationDbContext _context;

    public GetPoliciesQueryHandler(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<IReadOnlyList<ControlPolicyDto>> Handle(GetPoliciesQuery request, CancellationToken cancellationToken)
        => await _context.ControlPolicies
            .Where(p => p.Enabled)
            .OrderBy(p => p.Precedence)
            .Select(p => new ControlPolicyDto(
                p.Id, p.Code, p.Name, p.Condition, p.Action, p.LegacyCode, p.RuleFamily, p.Precedence, p.Enabled))
            .ToListAsync(cancellationToken);
}
