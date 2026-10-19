using Microsoft.AspNetCore.HttpOverrides;
using Mor.PowerManagement.Infrastructure.Data;
using Scalar.AspNetCore;
using Mor.PowerManagement.Infrastructure.Observability;
using Mor.PowerManagement.Web.Observability;

var builder = WebApplication.CreateBuilder(args);
var isDocGen = string.Join(' ', Environment.GetCommandLineArgs())
    .Contains("getdocument", StringComparison.OrdinalIgnoreCase);

if (!isDocGen && builder.Environment.IsProduction())
{
    if (string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("Mor.PowerManagementDb")))
    {
        throw new InvalidOperationException("Production requires ConnectionStrings__Mor.PowerManagementDb to be configured.");
    }

    var deviceApiKey = builder.Configuration["Device:ApiKey"];
    if (string.IsNullOrWhiteSpace(deviceApiKey) || deviceApiKey.Length < 32)
    {
        throw new InvalidOperationException("Production requires Device__ApiKey to be set to a random secret of at least 32 characters.");
    }
}

// Managed hosts (Render/Railway/Fly) hand us a dynamic port via $PORT.
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrWhiteSpace(port))
{
    builder.WebHost.UseUrls($"http://*:{port}");
}

// Add services to the container.
builder.AddServiceDefaults();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // TLS terminates at the host proxy; trust its forwarding headers.
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

// Short in-memory cache for the read-heavy dashboard endpoints (see
// Dashboard.cs). The console polls state twice a second and the database is
// cloud-hosted, so without this every poll pays a ~180 ms round trip and the
// console reads as lagging.
builder.Services.AddMemoryCache();

builder.AddKeyVaultIfConfigured();
builder.AddApplicationServices();
builder.AddInfrastructureServices();
builder.AddWebServices();
builder.AddTelemetryRequestMeasurement();

var app = builder.Build();

app.UseForwardedHeaders();
app.UseTelemetryRequestMeasurement();

// Migrations are safe to apply on startup for a single instance (Neon-safe:
// MigrateAsync never deletes). Hosted deploys have no dev machine to run
// `dotnet ef database update` from, so initialise in every environment —
// except the OpenAPI doc-generation tool run at build time, which executes
// this pipeline without a database.
if (!isDocGen)
{
    using var measurementScope = TelemetryActivityScope.Begin(TelemetryActivityCategory.Startup);
    await app.InitialiseDatabaseAsync();
}

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseCors(static builder => 
    builder.AllowAnyMethod()
        .AllowAnyHeader()
        .AllowAnyOrigin());

app.UseFileServer();

app.MapOpenApi();
app.MapScalarApiReference();

app.UseExceptionHandler(options => { });


app.MapDefaultEndpoints();
app.MapEndpoints(typeof(Program).Assembly);

app.MapFallbackToFile("index.html");

app.Run();
