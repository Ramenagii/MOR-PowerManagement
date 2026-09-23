# MOR Power Management — hosted build (Render / Railway / Fly).
# Frontend is compiled by the Web.csproj PublishRunWebpack target (npm build
# -> wwwroot), so no separate Node stage is needed here.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
# PublishRunWebpack runs `npm install && npm run build` for the React SPA,
# and the SDK image ships no Node — borrow it from the official Node image.
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
WORKDIR /src
COPY Mor.PowerManagement.slnx ./
COPY Directory.Build.props ./
COPY Directory.Packages.props ./
COPY global.json ./
COPY src/ ./src/
RUN dotnet publish src/Web/Web.csproj -c Release \
    -p:OpenApiGenerateDocuments=false \
    -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish ./
# Host injects $PORT; Program.cs binds to it. DB + device key via env:
#   ConnectionStrings__Mor.PowerManagementDb=<neon url>
#   Device__ApiKey=<shared secret, must match firmware DEVICE_API_KEY>
ENV ASPNETCORE_ENVIRONMENT=Production
ENTRYPOINT ["dotnet", "Mor.PowerManagement.Web.dll"]
