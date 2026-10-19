using System.Security.Claims;
using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Application.Power.Runtime;
using MediatR.Pipeline;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mor.PowerManagement.Application.Common.Behaviours;

public class LoggingBehaviour<TRequest> : IRequestPreProcessor<TRequest>
    where TRequest : notnull
{
    private readonly ILogger _logger;
    private readonly IUser _user;
    private readonly IIdentityService _identityService;
    private readonly bool _claimsOnly;
    private readonly ICurrentUserName? _currentUserName;

    public LoggingBehaviour(ILogger<TRequest> logger, IUser user, IIdentityService identityService)
    {
        _logger = logger;
        _user = user;
        _identityService = identityService;
    }

    public LoggingBehaviour(
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

    public async Task Process(TRequest request, CancellationToken cancellationToken)
    {
        var requestName = typeof(TRequest).Name;
        var userId = _user.Id ?? string.Empty;
        string? userName = string.Empty;

        if (!string.IsNullOrEmpty(userId))
        {
            userName = await CurrentUserName.ResolveAsync(userId, _claimsOnly, _currentUserName, _identityService);
        }

        _logger.LogInformation("Mor.PowerManagement Request: {Name} {@UserId} {@UserName} {@Request}",
            requestName, userId, userName, request);
    }
}

/// <summary>
/// The signed-in user's name as the authenticated principal already carries
/// it (the Identity cookie's name claim). Reading it needs no database.
/// Registered by the web host; absent elsewhere.
/// </summary>
public interface ICurrentUserName
{
    string? UserName { get; }
}

/// <summary>Reads the name claim from whatever principal the host supplies.</summary>
public sealed class ClaimsCurrentUserName(Func<ClaimsPrincipal?> principal) : ICurrentUserName
{
    public string? UserName
    {
        get
        {
            var user = principal();
            if (user?.Identity is not { IsAuthenticated: true } identity)
            {
                return null;
            }

            return identity.Name ?? user.FindFirst(ClaimTypes.Name)?.Value;
        }
    }
}

/// <summary>
/// Shared by the logging and performance behaviours (W-12 in the Neon wake
/// audit). The name is used only in a log line.
///
/// Cached reads OFF: unchanged, one <c>AspNetUsers</c> lookup through
/// <see cref="IIdentityService"/>. Cached reads ON: the name claim of the
/// authenticated principal, or empty (the user id is still logged) when there
/// is no name claim. Authentication, authorization and Identity's security
/// stamp validation are not involved either way.
/// </summary>
public static class CurrentUserName
{
    public static async Task<string?> ResolveAsync(string userId, bool claimsOnly, ICurrentUserName? fromClaims, IIdentityService identityService)
    {
        if (claimsOnly)
        {
            return fromClaims?.UserName ?? string.Empty;
        }

        return await identityService.GetUserNameAsync(userId);
    }
}
