using System.Diagnostics;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mor.PowerManagement.Application.Common.Behaviours;

public class PerformanceBehaviour<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    private readonly Stopwatch _timer;
    private readonly ILogger<TRequest> _logger;
    private readonly IUser _user;
    private readonly IIdentityService _identityService;
    private readonly bool _claimsOnly;
    private readonly ICurrentUserName? _currentUserName;

    public PerformanceBehaviour(
        ILogger<TRequest> logger,
        IUser user,
        IIdentityService identityService)
    {
        _timer = new Stopwatch();

        _logger = logger;
        _user = user;
        _identityService = identityService;
    }

    public PerformanceBehaviour(
        ILogger<TRequest> logger,
        IUser user,
        IIdentityService identityService,
        IOptions<PowerRuntimeOptions> runtimeOptions,
        IEnumerable<ICurrentUserName> currentUserName)
        : this(logger, user, identityService)
    {
        _claimsOnly = runtimeOptions.Value.CachedReadsEnabled;
        _currentUserName = currentUserName.LastOrDefault();
    }

    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        _timer.Start();

        var response = await next();

        _timer.Stop();

        var elapsedMilliseconds = _timer.ElapsedMilliseconds;

        if (elapsedMilliseconds > 500)
        {
            var requestName = typeof(TRequest).Name;
            var userId = _user.Id ?? string.Empty;
            var userName = string.Empty;

            if (!string.IsNullOrEmpty(userId))
            {
                userName = await CurrentUserName.ResolveAsync(userId, _claimsOnly, _currentUserName, _identityService);
            }

            _logger.LogWarning("Mor.PowerManagement Long Running Request: {Name} ({ElapsedMilliseconds} milliseconds) {@UserId} {@UserName} {@Request}",
                requestName, elapsedMilliseconds, userId, userName, request);
        }

        return response;
    }
}
