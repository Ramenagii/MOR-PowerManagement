# Production deployment (Render + Neon)

This service is a single ASP.NET Core container that serves the dashboard and
API. The root `Dockerfile` builds the React app and the .NET API together.

## Render service

Create a **Web Service** from this repository and choose **Docker**. Use the
repository root as the build context and `Dockerfile` as the Dockerfile path.
Keep one instance while the app applies database migrations during startup.
Render supplies `PORT`; the container listens on it.

Add these Render environment variables as secrets/configuration:

| Name | Value |
| --- | --- |
| `ASPNETCORE_ENVIRONMENT` | `Production` |
| `ConnectionStrings__Mor.PowerManagementDb` | Neon connection URI (`postgresql://...`) |
| `Device__ApiKey` | Random 32-byte secret, Base64URL encoded; use the same value in firmware `config.local.h` |
| `Admin__InitialPassword` | Unique password of at least 16 characters, used only to create the first admin or rotate the old seeded default |
| `Admin__ResetExistingPassword` | Optional one-time recovery switch. Set to `true` to reset the existing `administrator@localhost` password from `Admin__InitialPassword` at startup; remove it immediately after the successful startup log. |

Before deploying, rotate the Neon database owner's password and revoke/replace
the Render API key. The repository's security notes record that both appeared
in earlier plaintext transcripts. Update Render with the new Neon URI; never
commit either credential.

Generate a device key locally in PowerShell without putting it in Git:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$deviceKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$rng.Dispose()
$deviceKey
```

The Neon URL parser requires TLS in Production. Prefer the Neon direct connection
URI for first deploy/migrations. The app applies pending EF migrations at startup
and seeds missing application data without deleting the database. Keep the Render
service at one instance during migration startup.

After the first successful startup and administrator password rotation, remove
`Admin__InitialPassword` from Render. The account retains its new password.

### Recovering an existing administrator account

Changing `Admin__InitialPassword` does not replace an existing custom password.
If the existing administrator cannot sign in, temporarily keep/set
`Admin__InitialPassword` to the new password and add
`Admin__ResetExistingPassword=true` in Render. Deploy once and wait for the log
message that the existing administrator password was reset. Then remove
`Admin__ResetExistingPassword` from Render and deploy again. Do not leave the
reset switch enabled: while it is set, every service startup resets the account
password to `Admin__InitialPassword` and invalidates existing sign-in sessions.

## Firmware connection

If `firmware/mor-power-device/config.local.h` does not exist, copy the example
to that ignored path. If it already exists, preserve its Wi-Fi settings and add
the deployment macros. Set `BACKEND_HOST` to the Render hostname only (no scheme),
`BACKEND_PORT` to `443`, `BACKEND_USE_TLS` to `1`, and `DEVICE_API_KEY` to the
same key stored in Render. Build and flash the ESP32 after these values are set.
Never commit `config.local.h`; the checked-in firmware defaults contain no device
secret.

The former device key was present in tracked firmware source. Treat it as
compromised: use a newly generated key in Render and in local firmware config.

## Availability

This loop depends on the web process receiving telemetry continuously. Render's
Free web services spin down after 15 minutes without inbound requests, so they
cannot provide an always-on backend if the ESP32 stops posting. Use an always-on
Render instance for continuous operation. A sleeping Neon compute can also add a
cold-start delay after an idle period. Configure Neon to keep the compute active
if your plan supports disabling scale-to-zero; otherwise allow for wake-up delay.

## First deploy checks

1. Render build completes and the `/health` endpoint returns `Healthy`.
2. Logs show EF migrations completed and the service listening on Render's port.
3. Sign in as `administrator@localhost` with the password in your password
   manager; change it if the database had an existing account.
4. The ESP32 receives HTTP 200 from telemetry and config sync. A 401 indicates
   that its local `DEVICE_API_KEY` does not match Render's `Device__ApiKey`.
5. Confirm dashboard telemetry is recent and outlet/relay state matches the rig.

The dashboard is a monitoring/control prototype. Keep physical breakers and
other required electrical protections in place; software deployment does not
replace them.
