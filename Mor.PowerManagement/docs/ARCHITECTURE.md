# MOR Power Management — Architecture & Deployment Plan

Thesis rig: 13 control channels (8×220V outlets + 1×110V instrument outlet +
4×USB 5V sockets), one mains PZEM-004T on the common feed, ESP32-S3 edge
controller, ASP.NET Core backend, Postgres, React dashboard.

## 1. Topology

```
+------------------+   Wi-Fi (Tenda_7C8018)   +------------------+   +------------------+
| ESP32-S3         |  POST /api/Device/       | ASP.NET Core 10  |   | Postgres         |
| PowerFeather     |  telemetry (5s)          | Web API + React  |-->| Neon (now) /     |
| 13 relay GPIOs   |  GET  /api/Device/       | SPA from wwwroot |   | Pi-local (later) |
| 1 mains PZEM     |  config (15s)            +------------------+   +------------------+
| NVS policy table |                           ^  serves UI at /  ( :5211 )
+------------------+                           |
                                               v
                                    Browser dashboard (PC localhost,
                                    phone via http://<server-ip>:5211)
```

Current LAN: server PC `192.168.0.101`, ESP32 `192.168.0.113` (DHCP),
backend binds `http://0.0.0.0:5211` so LAN devices reach it.

## 2. Component responsibilities

| Layer | Lives on | Does | Survives backend outage? |
|---|---|---|---|
| Edge control | ESP32-S3 flash | PZEM polling (or SIM synthesis), POL-01..08 local enforcement, relay drive, telemetry/config sync | Yes — NVS policy table (`MOR2`) restores on boot |
| System of record | Backend + Postgres | Users/roles, outlet policy, thresholds, telemetry history, power events, shedding orchestration | N/A (it is the record) |
| Presentation | Browser SPA | Login, live load, outlet cards, policies, hardware view, ESP32 online pill | Shows last fetched state |

Deliberate split: the edge decides in milliseconds; the server remembers
everything. The full stack cannot fit on the S3 (512KB RAM / 8MB flash vs
~100MB+ for the .NET + DB stack), so "all in the microcontroller" is not
physically possible — autonomy (edge) vs memory (server) is the thesis point.

## 3. ESP32 firmware modes (`firmware/mor-power-device/config.h`)

- `SIMULATE_METERS 1` — bench/demo placeholder. Synthesizes mains load from
  energized allowances (`0.72` factor mirrors the backend activation
  estimate). No PZEM, relays, or outlets required. Serial shows per-channel
  lines: `channels: 1:o0W ... 10:C18W ...` (`C` = closed, `o` = open;
  CH1–8 = 220V, CH9 = 110V, CH10–13 = USB).
- `SIMULATE_METERS 0` — real hardware. Single mains PZEM (address 1,
  RX16/TX17); per-channel watts estimated from the mains total weighted by
  allowance. Relay pins: `{4,5,6,7,8,9,10,11,12,13,14,15,18}` (S3-safe,
  avoids strapping/USB/flash pins).

Wi-Fi + backend target: `WIFI_SSID` / `WIFI_PASS` / `BACKEND_HOST` /
`BACKEND_PORT` in `config.h`. Boot proof on serial @115200:
`IP: 192.168.0.113` → `config synced: … 13 channels` → `telemetry: HTTP 200`.

## 4. Backend configuration

- Dev (this PC): connection string in user-secrets
  (`ConnectionStrings:Mor.PowerManagementDb`, Neon URL, normalized to
  Npgsql format by `NormalizePostgresConnectionString`). Migrations auto-run
  in Development via `InitialiseDatabaseAsync()`.
- Prod (Pi/cloud): set `ConnectionStrings__Mor.PowerManagementDb` env var
  and run `dotnet ef database update` once (auto-migrate runs in Development
  only). `Device:ApiKey` empty = open LAN; set it + matching
  `DEVICE_API_KEY` in firmware when the rig leaves the lab.
- Demo accounts (seeded, lockout disabled): `administrator@localhost` /
  `Administrator1!`, `demo@localhost` / `Demo1234!`.

## 5. Deployment stages

- **Stage 0 — PC demo (done).** `dotnet run --urls http://0.0.0.0:5211`,
  SIM firmware, Neon DB, dashboard on `http://<pc-ip>:5211`.
- **Stage 1 — Pi LAN box (panel-ready).** Raspberry Pi 4/5 + .NET 10 ARM64
  runtime, `dotnet publish -c Release`, copy output, systemd service on
  port 5211, env-var connection string, point `BACKEND_HOST` at the Pi IP,
  reflash ESP32. Optional: move DB to Pi-local Postgres for zero-cloud
  operation.
  Verified publish command (Windows host → Pi, framework-dependent;
  `OpenApiGenerateDocuments=false` works around the ARM64 doc-tool load
  failure, checked-in `wwwroot/openapi/v1.json` is used as-is):
  `dotnet publish src/Web/Web.csproj -c Release -r linux-arm64 --no-self-contained -p:OpenApiGenerateDocuments=false`
  then `dotnet Mor.PowerManagement.Web.dll --urls http://0.0.0.0:5211` with
  `ConnectionStrings__Mor.PowerManagementDb` set and
  `dotnet ef database update` run once beforehand.
- **Stage 2 — Real hardware.** Wire relays/PZEM/CTs, set `SIMULATE_METERS 0`,
  reflash, re-validate thresholds against measured loads, keep SIM build as
  the documented fallback for bench tests.
- **Stage 3 — Public host (any device, no PC).** The app is host-ready:
  `Dockerfile` at the solution root, `$PORT` binding, forwarded headers for
  the host TLS proxy, and startup migrations in every environment.
  1. Push to GitHub (done) and create a Render/Railway/Fly web service from
     this repo (Docker build, no local Docker needed).
  2. Env vars on the host: `ASPNETCORE_ENVIRONMENT=Production`,
     `ConnectionStrings__Mor.PowerManagementDb=<Neon URL>`,
     `Device__ApiKey=<shared secret>`. First boot auto-migrates Neon.
  3. Note the public URL, e.g. `https://mor-power.onrender.com`.
  4. Firmware for public backend: `BACKEND_HOST` = host domain (no
     `https://`), `BACKEND_PORT 443`, `BACKEND_USE_TLS 1`,
     `DEVICE_API_KEY` = same secret, reflash. Real certs are verified by
     the host, so the firmware's insecure dev-cert mode is not used.
  5. Dashboard + ESP32 then work from any device anywhere; the PC can stay
     off. Free-tier hosts sleep when idle — first load and device sync take
     ~30s to wake.

## 6. Operability (how you know it works)

- Serial @115200: `IP:` → Wi-Fi ok; `config synced` → backend reachable;
  `telemetry: HTTP 200` every 5s → healthy loop; `HTTP -1` → backend down;
  `Wi-Fi failed` → credentials/router.
- Dashboard header: `ESP32 online` = telemetry within 30s
  (`deviceOnline` from max `LastSeen`); `ESP32 offline` otherwise.
- Login: cookie auth; Identity `/login` returns 200 with empty body, so the
  SPA parses responses defensively (empty body ≠ failure).

## 7. Known limits / thesis honesty

- Per-channel watts are *estimated* from one mains meter (allowance-weighted),
  not individually metered. Fine for policy demos; not revenue-grade metering.
- Functional/acceptance test projects fail on Aspire resource naming
  (`Mor.PowerManagementDb` contains dots); unit suites pass (Domain 6/6,
  Application 8/8, ClientApp 5/5).
- Wi-Fi credentials live in `config.h` — keep the repo private.
