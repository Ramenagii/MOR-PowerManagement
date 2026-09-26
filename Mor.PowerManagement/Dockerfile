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
# Something in the dependency chain P/Invokes GSSAPI (Kerberos); ensure the
# system library exists whichever distro this base image is built on.
USER root
RUN if command -v tdnf >/dev/null 2>&1; then tdnf install -y krb5-libs && tdnf clean all; \
    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends libgssapi-krb5-2 && rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache krb5-libs; fi
USER app
WORKDIR /app
COPY --from=build /app/publish ./
# Host injects $PORT; Program.cs binds to it. DB + device key via env:
#   ConnectionStrings__Mor.PowerManagementDb=<neon url>
#   Device__ApiKey=<shared secret, must match firmware DEVICE_API_KEY>
ENV ASPNETCORE_ENVIRONMENT=Production
ENTRYPOINT ["dotnet", "Mor.PowerManagement.Web.dll"]
