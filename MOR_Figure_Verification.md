# Figure verification — `MOR_Ch3_Methodology_Figures_Mermaid.md`

Justification for the five Chapter 3 figures in this repository, checked against the text of the
**Ch. 3 Revision** tab (`t.13td6aj76ye4`, 1,105 lines) — the live manuscript.

Counts are exact occurrences in that tab:

```
[System.IO.File]::ReadAllText("<tabs>\Ch3_Revision.txt")
[regex]::Matches($text, "<term>", 'IgnoreCase').Count
```

## Result: all five figures supported

| Figure | Claim in the diagram | Ch. 3 Revision evidence | Verdict |
|---|---|---|---|
| **Figure 3** Block Diagram | six switched branches | branch model throughout §3.5 | supported |
| | ZMCT103C per outlet | ×15 | supported |
| | ADS1115 | ×2, and `ADS1015` **×0** | supported |
| | PZEM-004T aggregate V/I/W | ×14 | supported |
| | ESP32-S3 as MCU | named as the microcontroller | supported |
| | 10 A fuse + 300 V varistor | `fuse` ×4, `varistor` ×2, `surge` ×2 | supported |
| | AC-DC step-down to 5 V | "AC-DC Step-Down Converter … 5V DC" | supported |
| | Firebase telemetry | ×18 | supported |
| **Figure 4** ECA Polling Loop | POL-01 … POL-08 | 29 `POL-0x` references | supported |
| | precedence POL-01 → 05/06/07 → 02/03 → 08 | §Precedence Hierarchy, 4 numbered tiers | supported |
| | deterministic, no relay oscillation | `deterministic` ×5; "prevent non-deterministic relay oscillation" | supported |
| | lockout flags | ×2 | supported |
| **Figure 5** Branch Activation | POL-02 / POL-03 / POL-04 | Table 6 Execution Matrix | supported |
| | 500 ms inrush stabilisation | `500ms` ×2, `inrush` ×2, `stabilization` ×4 | supported |
| | ACT_ALLOW / ACT_DENY / ACT_SHED | Table 5 Action Space | supported |
| **Figure 6** Selective Load Response | POL-05 low → POL-06 medium | stated verbatim in §3.5 | supported |
| | POL-07 preserves `O_priority_i == 3` | stated verbatim; ACT_PRESERVE | supported |
| **Figure 2** Process Flowchart | developmental-evaluative design | §3.1, `ISO/IEC 25010` ×4 | supported |
| | ISO/IEC 25010 user evaluation | §3.3 survey instrument | supported |

Every node, edge, threshold, and rule identifier in the five diagrams traces to text in the
manuscript. No element was imported from the GPT tab or from any other source.

## Open findings about Chapter 3, independent of the figures

These surfaced during verification and still apply:

1. **No output-state model.** Table 5 defines *actions* (`ACT_ALLOW`, `ACT_DENY`, `ACT_SHED`,
   `ACT_PRESERVE`, `ACT_FAULT`) but no *states*. There is no pending / unverified / verified
   vocabulary anywhere in the chapter. If the project needs it, it must be written into §3.5.1.3 —
   a figure cannot be the only place a design exists.
2. **No tie-break rule.** §Conflict Resolution defines precedence between policy *tiers* but never
   states how equal-priority shedding candidates are ordered. A panelist can legitimately ask.
3. **No `110 V`, no `USB`, no `tower` in this tab** — all ×0. If those are in scope, Chapter 3 as
   written does not describe them.
4. **Acceptance tolerances are unset.** §3.3.2.1 in the corresponding section states the tolerances
   "remain to be finalized", so the evaluation cannot yet produce a pass/fail result.

## Scope note

An earlier revision of this repository also carried a GPT-ported figure set (Figures 7–11). It was
removed: two of those figures asserted constructs absent from this tab, and the rest duplicated
figures already present. The GPT tab remains useful as a *reference* — it contains the fuller
rationale, the state model, and the provenance audit — but its figures are not a substitute for the
five above.
