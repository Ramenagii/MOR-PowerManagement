# MOR Power Management — Roadmap & Admin Console Plan

Status: **planning only — no code changes made against this document.**
Last updated: 2026-10-02 · Author: Cline · Reviewed by: _(pending)_

This document is the working plan for the admin/management side of the
dashboard, the statistical-graph work, and the Neon + GitHub progression
strategy. It supersedes nothing in [ARCHITECTURE.md](./ARCHITECTURE.md); that
document remains the source of truth for topology, deployment, and known limits.

---

## 0. Where we actually are

| Area | State |
|---|---|
| Telemetry API | ✅ Fixed & live in prod (`b57399a`) |
| Telemetry UI (V/A/W time series, provenance) | ✅ Done, serving real Neon data |
| Dashboard UI (13 outlets, events, poll) | ✅ Done |
| Policies / Hardware views | ✅ Read-only |
| **Admin writes (thresholds, per-outlet policy)** | ❌ Backend exists, **zero UI** |
| **Statistical graphs** | ❌ Not built |
| **Scenario panel honesty** | ⚠️ 4 of 6 buttons are fake |

The backend is not the constraint. `UpdateThresholdsCommand` and
`UpdateOutletPolicyCommand` are fully implemented, validated, and exposed at
`PUT /api/Dashboard/thresholds` and `PUT /api/Dashboard/outlets/{id}/policy`.
The frontend simply never calls them. This is a UI gap, not a backend gap —
which de-risks the largest chunk of the work.

---

## 1. Neon + GitHub progression strategy

### 1.1 Neon branching

The data story is currently weak: 89,752 raw rows spanning ~1 day, because the
Render free tier sleeps and the rig can only post in ~15-minute bursts.

- **`main`** — production. 3-day retention. Feeds the live demo.
- **`dev`** — persistent dev branch, seeded with ~30 days of history. Develop
  the statistics UI against a full dataset without polluting production.
- **Ephemeral branches per feature** — Neon provisions a throwaway copy in
  seconds, so statistical query experiments can run against real cardinality
  at no storage cost.

### 1.2 Schema additions this roadmap needs

**`TelemetryReadingsHourly`** — hourly rollup table:

```
(bucket_start, OutletId)
  -> avg/min/max Voltage, avg/max CurrentAmps, sum/peak PowerWatts, energy delta
```

30 days x 13 channels x 24 h = **9,360 rows**, versus ~1.5M raw samples. Makes
7d/30d statistics instant instead of a heavy scan. Add continuous aggregates on
top if percentile bands are wanted.

**Storage budget:** raw at 3-day retention is about 103 MB; the 30-day rollup is
negligible. The 0.5 GB Neon free tier has room, but raw retention is the
dominant cost and must stay capped.

### 1.3 GitHub as a progression log

- **Issues** = roadmap items, one per milestone, labelled `admin-ui`, `stats`,
  `honesty`, `docs`, `security`.
- **Milestone** per phase, so the defense shows a real burn-down chart.
- Conventional commits + PRs, so `git log` reads as progress evidence.
- `CHANGELOG.md` and `docs/DECISIONS.md` (ADR-style). Thesis reviewers reward
  documented rationale more than code volume.

---

## 2. Admin Console: sensors with V / A / W

### 2.1 Sensor inventory view

One card per channel, all 13:

```
┌─ CH3 · Outlet 3 ────────────── 220 V mains ─┐
│  ● Active     Priority: Medium              │
│  219.4 V   1.82 A   401 W                   │
│  ▓▓▓▓▓▓▓░░░  401 / 550 W allowance         │
│  Relay: GPIO4    Meter: shared PZEM         │
│  Last sample: 2 s ago                       │
└──────────────────────────────────────────────┘
```

Live V/A/W per channel, relay state, priority, allowance meter, provenance
badge. Aggregate strip above the grid: total watts, energized count, % of
capacity, system state chip, device-online indicator.

**Backend gap.** `GET /Dashboard/state` already returns `watts`,
`ratedVoltageVolts`, `status`, and `relayChannel`, but **not** per-channel volts
or current — those exist only inside the aggregated telemetry endpoint. Add a
lightweight `GET /Dashboard/sensors` returning the latest raw row per outlet:

```sql
SELECT DISTINCT ON ("OutletId") ...
  FROM "TelemetryReadings"
 ORDER BY "OutletId", "Timestamp" DESC
```

One indexed query, no aggregation, cheap.

### 2.2 Statistical graphs

Tiered so value arrives early and each tier is independently shippable.

**Tier 1 — window statistics (no new query).**
`seriesStats()` already exists in `ClientApp/src/utils/telemetry.ts`
(min/max/last/sum). Extend with mean, standard deviation, and
percent-of-window-energized. Render a stat strip per channel above each chart:
`min · mean · max · σ`. Free — the data is already in the payload.

**Tier 2 — distribution / histogram.**
Per-channel histogram of watts across the window, bucketed client-side from the
array already held in memory. Answers "how much does CH7 actually draw?" and
separates idle from active populations.

**Tier 3 — hourly rollups (new query).**
Mean/min/max volts, mean/max amps, peak watts, energy kWh per hour per channel,
read from the rollup table. Powers a **channel x hour heatmap** — a strong
defense visual, cheap at 9,360 rows.

**Tier 4 — energy & cost.**
kWh per channel per day from `EnergyKwh` deltas, plus a cost/PF estimate. The
UI must state plainly that per-channel energy is *derived*, not metered.

**Design constraint:** reuse the hand-rolled SVG approach already in
`TimeSeriesChart.tsx`. No new npm dependency keeps the Docker build shape
unchanged — that constraint was deliberate in `e9e0301` and is why deploys stay
cheap.

---

## 3. Google Stitch draft

Stitch (Google Labs, Gemini 3-powered) takes text/image prompts and generates UI
screens; its "Prototypes" feature stitches screens into flows. **Use it for
visual direction only, not for logic.**

### Master prompt

> Design a dark-mode industrial IoT monitoring console for an academic thesis
> defense on power management. Three screens.
>
> **Screen 1 — Sensor Inventory:** a responsive card grid of 13 sensor channels.
> Each card shows channel ID, name, live voltage / current / wattage as large
> monospace numerals, a status pill (Active / Standby / Restricted /
> Disconnected), a horizontal allowance meter, and a small provenance badge.
> Top bar: aggregate total watts, % of capacity, system state chip, device-online
> indicator.
>
> **Screen 2 — Telemetry & Statistics:** stacked time-series charts (voltage,
> current, watts) with a window selector (15m/1h/6h/24h/7d) and per-channel
> toggles. Above each chart a stat strip: min / mean / max / sigma. Include a
> per-channel load histogram and a channel x hour heatmap.
>
> **Screen 3 — Administration:** threshold editors (max capacity, warning,
> critical, standby, idle minutes, stabilization delay) and a per-outlet policy
> table (priority, allowance watts, schedule, idle limit) with inline editing and
> save.
>
> Style: dark slate background, cyan/blue accent, Inter + JetBrains Mono for
> numerals, dense but breathable, engineering-instrument feel. Accessible
> contrast, no decorative gradients.

### Caveats

- Stitch will invent numbers and will drop the honesty captions. The
  `PROVENANCE_COPY` strings in `ClientApp/src/data/telemetry.ts` are the
  defensible core of this thesis — **never** let generated copy replace them.
- Verify generated accessibility claims manually. Stitch output needs review
  before it goes near a defense panel.
- Expect a light-vs-dark conflict: the current stylesheet is light
  (`--surface #ffffff`, per the contrast notes in `telemetry.ts`), while Stitch
  will likely default dark. See open decision D4.
---

## 4. Milestones

| # | Milestone | Deliverable | Risk |
|---|---|---|---|
| **0** | **Security rotation** | Neon password + Render API key rotated | Do first |
| **1** | Scenario-panel honesty | Fake buttons labelled, or made real | Defense-critical |
| **2** | `GET /Dashboard/sensors` | Latest raw reading per outlet | New query |
| **3** | Admin settings UI | Wire the 2 existing PUTs | Backend ready |
| **4** | Stats tier 1+2 | Stat strips + histograms, no new query | Client-only |
| **5** | Seeder + 30d dev branch | Presentable charts | Storage |
| **6** | Rollup table + tier 3 | Heatmap, 30d windows | New migration |
| **7** | Docs reconciliation | Fix the 4 doc mismatches | Doc only |
| **8** | Energy/cost tier 4 | kWh + cost | Optional |

### Why milestone 1 comes early

Today "Post-activation overload" writes `watts: 460` into React state and
fabricates an event (`App.tsx`: `blockInsufficientCapacity`,
`postActivationOverload`, and `idleShutdown` are local-only). If a panelist
clicks it and watches the chart, **nothing moves** — because the chart reads
Postgres.

The honest fix is cheap: route the demo through `POST /api/Device/telemetry`
with a raised load. That writes real rows, moves the charts, and makes the
control-action and telemetry-evidence stories agree. Worth more to the defense
than any chart type in section 2.2.

Note also that `requestActivation` hardcodes outlet **6** (`App.tsx`), so that
demo only ever touches one channel.

---

## 5. Security — outstanding, do first

Neither secret below has been rotated. Both are in plaintext in prior
transcripts.

1. **Neon `neondb_owner` password** — full-privilege DB role. Appeared in this
   transcript twice (once via a redaction regex that missed the URI format, once
   inside a connection-string exception). Also lives in local user-secrets and
   in Render's `ConnectionStrings__Mor.PowerManagementDb` env var. Rotate in the
   Neon dashboard, then update user-secrets and Render together.
2. **Render API key** — full account access (read service config, trigger
   deploys). Pasted in plaintext during the `b57399a` deploy. Revoke in Render,
   Account Settings, API Keys, and issue a new one.

---

## 6. Known housekeeping (untouched)

- `docs/ARCHITECTURE.md:110` still lists the placeholder
  `https://mor-power.onrender.com`. The real host is
  `mor-powermanagement.onrender.com`, from
  `firmware/mor-power-device/config.h:28`.
- Doc/code mismatches: channel count (doc says 6 outlets + 1x110 V + 2 USB = 9;
  code has 13), power limit (2,500 W vs implemented), rule IDs (FR-01..FR-08 vs
  POL-01..POL-08), Wi-Fi setup (the `MOR-Setup` captive portal was removed).
- `opencode.db` is 7.8 GB and is implicated in session crashes.
- `mor-power-management-dashboard` is a gitlink with no `.gitmodules`.
- ~40 test projects show as unstaged deletions in the working tree. They were
  committed at `6200e9e`, so `git restore tests/` recovers them if the deletion
  was not deliberate.
- **Render auto-deploy did not fire** on the `b57399a` push despite
  `autoDeploy: yes` and `autoDeployTrigger: commit`. The build had to be
  triggered manually. Do not trust auto-deploy for the next push — verify.

---

## 7. Open decisions

| ID | Question | Recommendation |
|---|---|---|
| **D1** | Milestone 1: label the fake scenario buttons as simulated, or rebuild them to post real telemetry? | **Rebuild** via `/Device/telemetry` |
| **D2** | Stitch prompts: keep in this file, or split into `docs/stitch/*.md` per screen? | Split per screen for reuse |
| **D3** | Are energy/cost (tier 4) and 30-day windows actually needed for the defense? | Decide before building the rollup table (milestone 6) |
| **D4** | Dark theme, or keep the current light stylesheet? | Ask before styling work starts |