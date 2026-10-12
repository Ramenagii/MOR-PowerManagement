# Figure verification against Chapter 3 (tab "Ch. 3 Revision")

Every element of both figure sets was checked against the text of the **Ch. 3 Revision** tab
(`t.13td6aj76ye4`, 1,105 lines). Counts are exact occurrences in that tab.

## Method

```
[System.IO.File]::ReadAllText("<tabs>\Ch3_Revision.txt")
[regex]::Matches($text, "<term>", 'IgnoreCase').Count
```

## Verdict

### Figures 2–6 — `MOR_Ch3_Methodology_Figures_Mermaid.md` — **justified**

| Figure claim | Ch. 3 Revision | Verdict |
|---|---|---|
| Six switched branches | branch model throughout | supported |
| ZMCT103C per outlet | ×15 | supported |
| ADS1115 | ×2, and `ADS1015` ×0 | supported |
| PZEM-004T aggregate V/I/W | ×14 | supported |
| ESP32-S3 | named as the MCU | supported |
| 5 V relays | Table 2, Hardware Requirements | supported |
| 10 A fuse + 300 V varistor | `fuse` ×4, `varistor` ×2, `surge` ×2 | supported |
| AC-DC step-down to 5 V | "AC-DC Step-Down Converter … 5V DC" | supported |
| POL-01 … POL-08 | 29 `POL-0x` references | supported |
| Precedence POL-01 → 05/06/07 → 02/03 → 08 | §Precedence Hierarchy, 4 numbered tiers | supported |
| 500 ms inrush stabilisation | `500ms` ×2, `inrush` ×2, `stabilization` ×4 | supported |
| POL-05 low → POL-06 medium → POL-07 preserved | stated verbatim | supported |
| Deterministic, no relay oscillation | `deterministic` ×5 | supported |
| Firebase telemetry push per cycle | `Firebase` ×18 | supported |

### Figures 7–11 — `MOR_Ch3_GPT_Methodology_Figures.md` — **mixed; two corrected**

| Figure | Status | Finding |
|---|---|---|
| Figure 7 Iterative R&D | **not supported as written** | `increment` ×0, `iterative` ×0. Ch. 3 says *"quantitative developmental-evaluative research design"* (`Ch3_Revision.txt:350`). Also duplicates the existing Figure 2. |
| Figure 8 Hardware I-P-O | supported, but duplicative | All hardware claims verified. Overlaps your existing Figure 3. |
| Figure 9 Software Architecture | **corrected** | Was *"Identity and roles — Administrator, Student Assistant"*. `Student Assistant` ×0 and `Authentication` ×0. Ch. 3 actually states: *"identity is translated into outlet roles, such as instructor-use, student-use, or general-use."* Now uses outlet roles. |
| Figure 10 Current Sensing | **cannot be judged from the manuscript** | Describes *present* firmware behaviour, inherited from GPT's audit of a different baseline. Ch. 3 describes *intended* behaviour only. |
| Figure 11 Proposed System I-P-O | **corrected** | First draft used `Activation-Pending`, `ON-Unverified`, `ON-Verified`, `Disconnection-Pending`, `Fault/Restricted`, `Ready-OFF`, `OFF-Verified` — **all ×0** — plus a tie-break rule (`tie-break` ×0). Ch. 3 Table 5 defines only action identifiers. Rewritten using POL-01…POL-08, `ACT_*`, `P_total`/`P_limit`, and the 500 ms delay. |

## Consequences worth deciding

1. **No output-state model exists in Ch. 3.** Table 5 defines actions (`ACT_ALLOW`, `ACT_DENY`,
   `ACT_SHED`, `ACT_PRESERVE`, `ACT_FAULT`) but no states. If the project needs pending/unverified/
   verified states, that has to be written into §3.5.1.3 — a figure cannot be the only place a design
   exists.
2. **No tie-break rule is specified.** §Conflict Resolution defines precedence between policy
   *tiers*, but not how to order equal-priority shedding candidates. Figure 11 no longer invents one.
3. **Figure 10 needs a real source.** The honest options are (a) verify it against the firmware in
   this repository, or (b) relabel it as proposed rather than current. Do not ship it labelled
   "current behaviour" without one of those.
4. **Ch. 3 contains no `110 V`, no `USB`, and no `tower`** (all ×0). The nine-unit GPT configuration,
   the 110 V/USB 5 V scope, and the tower form factor live only in the GPT tab. If those are in scope,
   Ch. 3 does not currently describe them.
