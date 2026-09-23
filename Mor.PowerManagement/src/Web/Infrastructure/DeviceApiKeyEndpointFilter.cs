using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace Mor.PowerManagement.Web.Infrastructure;

/// <summary>
/// Shared-secret authentication for the ESP32 device endpoints.
/// The ESP32 sends the key in the <c>X-Device-Key</c> header; it is compared
/// against <c>Device:ApiKey</c> configuration (env var <c>Device__ApiKey</c>).
/// When no key is configured the filter passes through so the local
/// development and defense-demo setup works without extra secrets.
/// </summary>
public class DeviceApiKeyEndpointFilter : IEndpointFilter
{
    private readonly IConfiguration _configuration;

    public DeviceApiKeyEndpointFilter(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var configuredKey = _configuration["Device:ApiKey"];

        if (string.IsNullOrWhiteSpace(configuredKey))
        {
            return await next(context);
        }

        if (!context.HttpContext.Request.Headers.TryGetValue("X-Device-Key", out var provided)
            || provided.Count != 1
            || !string.Equals(provided.ToString(), configuredKey, StringComparison.Ordinal))
        {
            return TypedResults.Unauthorized();
        }

        return await next(context);
    }
}
