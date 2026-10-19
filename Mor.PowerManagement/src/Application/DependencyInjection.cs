using System.Reflection;
using Mor.PowerManagement.Application.Common.Behaviours;
using Mor.PowerManagement.Application.Power.Runtime;
using Mor.PowerManagement.Application.Power.Services;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Microsoft.Extensions.DependencyInjection;

public static class DependencyInjection
{
    public static void AddApplicationServices(this IHostApplicationBuilder builder)
    {
        builder.Services.AddAutoMapper(cfg => 
            cfg.AddMaps(Assembly.GetExecutingAssembly()));

        builder.Services.AddValidatorsFromAssembly(Assembly.GetExecutingAssembly());

        // The load-shedding framework's cross-batch counters and shed ledger.
        // Singleton: the state is per-rig, and two concurrent requests must
        // serialise on the same state rather than each holding their own.
        builder.Services.AddSingleton<LoadSheddingStateStore>();

        // PLAN-0001 Spec D runtime snapshot. Telemetry:CachedReadsEnabled
        // defaults to false; while it is false the store is inert and the
        // coordinator runs every mutation on the legacy path.
        var runtimeOptions = PowerRuntimeOptions.FromConfiguration(builder.Configuration);
        builder.Services.AddSingleton(Microsoft.Extensions.Options.Options.Create(runtimeOptions));
        builder.Services.AddSingleton<IPowerRuntimeStore, PowerRuntimeStore>();
        builder.Services.AddSingleton<PowerMutationCoordinator>();

        builder.Services.AddMediatR(cfg => {
            cfg.RegisterServicesFromAssembly(Assembly.GetExecutingAssembly());
            cfg.AddOpenRequestPreProcessor(typeof(LoggingBehaviour<>));
            cfg.AddOpenBehavior(typeof(UnhandledExceptionBehaviour<,>));
            cfg.AddOpenBehavior(typeof(AuthorizationBehaviour<,>));
            cfg.AddOpenBehavior(typeof(ValidationBehaviour<,>));
            cfg.AddOpenBehavior(typeof(PerformanceBehaviour<,>));
        });
    }
}
