using Microsoft.AspNetCore.HttpOverrides;
using Mor.PowerManagement.Infrastructure.Data;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

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

builder.AddKeyVaultIfConfigured();
builder.AddApplicationServices();
builder.AddInfrastructureServices();
builder.AddWebServices();

var app = builder.Build();

app.UseForwardedHeaders();

// Migrations are safe to apply on startup for a single instance (Neon-safe:
// MigrateAsync never deletes). Hosted deploys have no dev machine to run
// `dotnet ef database update` from, so initialise in every environment —
// except the OpenAPI doc-generation tool run at build time, which executes
// this pipeline without a database.
var isDocGen = string.Join(' ', Environment.GetCommandLineArgs())
    .Contains("getdocument", StringComparison.OrdinalIgnoreCase);
if (!isDocGen)
{
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
