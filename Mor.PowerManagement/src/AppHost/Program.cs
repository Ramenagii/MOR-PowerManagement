using Mor.PowerManagement.Shared;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddAzureContainerAppEnvironment("aca-env");

// Neon-for-all-envs: the connection string comes from AppHost configuration
// (ConnectionStrings__Mor.PowerManagementDb env var, AppHost appsettings, or parameters)
// instead of a local Postgres container.
var database = builder.AddConnectionString(Services.Database);

var web = builder.AddProject<Projects.Web>(Services.WebApi)
    .WithReference(database)
    .WithExternalHttpEndpoints()
    .WithAspNetCoreEnvironment()
    .WithUrlForEndpoint("http", url =>
    {
        url.DisplayText = "Scalar API Reference";
        url.Url = "/scalar";
    });

if (builder.ExecutionContext.IsRunMode)
{
    builder.AddJavaScriptApp(Services.WebFrontend, "./../Web/ClientApp")
        .WithRunScript("start")
        .WithReference(web)
        .WaitFor(web)
        .WithHttpEndpoint(env: "PORT")
        .WithExternalHttpEndpoints();
}

builder.Build().Run();
