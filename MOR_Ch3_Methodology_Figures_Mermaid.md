# Chapter 3 — Methodology Figures (Mermaid source)

Basis: Google Doc tab **"Ch. 3 Revision"** (`t.13td6aj76ye4`).
Each block is standalone — paste straight into <https://mermaid.live> → *Copy SVG* → drop into Miro, or use
Miro's **Apps → Mermaid** / *Insert → Code block* if your board supports it.

Figures are numbered to match the existing List of Figures (Figure 2 → Figure 6). Captions and the
"Diagram Description" paragraphs already exist in the manuscript — this file only supplies the diagrams.

---

## Figure 2: Process Flowchart of the Research

Manuscript source: §3.2 Flowchart of Research Design / Process Flowchart.

```mermaid
flowchart TD
    A(["Start"]) --> B["Identify and research the problem<br/>Determine existing gaps the system aims to address"]
    B --> C["Review of related literature and studies<br/>Establish theoretical and technical foundation"]
    C --> D["Define research objectives, scope, and limitations"]
    D --> E{"Is the research topic<br/>clear and comprehensive?"}
    E -- "No" --> B
    E -- "Yes" --> F["System design and planning<br/>Architecture, functionalities,<br/>implementation strategies"]
    F --> G["Develop prototype"]
    G --> H["Technical testing and evaluation<br/>Functionality, load-monitoring accuracy,<br/>response time, policy enforcement"]
    H --> I{"Does the prototype<br/>meet the required criteria?"}
    I -- "No" --> J["Revise and improve the design"]
    J --> G
    I -- "Yes" --> K["User-based testing and evaluation<br/>ISO/IEC 25010 user-perception survey<br/>by intended users and testers"]
    K --> L{"Is the user evaluation<br/>successful?"}
    L -- "No" --> F
    L -- "Yes" --> M(["Design finalized and completed"])
```

> Loop-backs `E → B` and `L → F` mirror the manuscript text at §3.2; `I → J → G` is the revise-and-retest
> cycle. Keep both — a single-pass flow is what the panel reads as "no iteration was actually performed."

---

## Figure 3: Block Diagram of the System

Manuscript source: §3.5 Design Project Flow, "Diagram Description". Closes the loop the adviser asked for:
sensing → decision → switching → back to sensing.

```mermaid
flowchart LR
    AC(["AC Mains Input"]) --> FUSE["10 A fuse<br/>overcurrent trip"]
    AC --> MOV["300 V varistor<br/>voltage-spike suppression"]
    FUSE --> MOV
    FUSE --> PZEM["PZEM-004T<br/>aggregate voltage, current, wattage"]
    MOV --> PZEM

    PZEM --> SPLIT{"Split into 6 branches"}
    SPLIT --> BR["BRANCH i &nbsp;(i = 1 … 6)<br/>socket outlet<br/>user peripherals plugged in"]

    BR -->|"branch current"| CT["ZMCT103C<br/>per-branch current sensor"]
    CT --> ADC["ADS1115<br/>16-bit ADC<br/>cleaner readings than the ESP32 ADC"]
    ADC -->|"context snapshot"| MCU["CONTROL — ESP32-S3-WROOM-1<br/>context-aware decision logic<br/>ECA loop: POL-01 … POL-08"]
    MCU -->|"GPIO drive command"| RELAY["5 V relay modules<br/>switch each outlet"]
    RELAY --> BR

    ACDC["AC-DC step-down<br/>220/240 V AC to 5 V DC"] -.->|"5 V rail"| PZEM
    ACDC -.->|"5 V rail"| CT
    ACDC -.->|"5 V rail"| MCU
    ACDC -.->|"coil supply"| RELAY

    MCU <-->|"Wi-Fi uplink — telemetry"| FB[("Firebase Realtime Database<br/>telemetry and event logs")]
    FB <-->|"Wi-Fi downlink — policy and config"| DASH(["Admin web dashboard<br/>policy and outlet configuration"])
```

> **The closed loop is `BR → CT → ADC → MCU → RELAY → BR`** — sense, decide, switch, load returns. Keep all
> five arrows visible. That loop is what the adviser asked for in the "Closed-Loop Hardware Block Diagram"
> item; a diagram that stops at the ESP32 reads as a wiring sketch, not a control system.
>
> No `subgraph` blocks are used on purpose. Mermaid relocates a node that is referenced by an edge *before* its
> own subgraph is declared, which produced an empty "Control" box and a tangled left-to-right flow on the first
> draft. If you want grouping in Miro, group the boxes by hand after import.

> The dashed `B1 → CT` edge is the feedback path. If your board resists drawing it, keep the edge — it is the
> single thing that makes this a *closed-loop* diagram rather than a wiring sketch.

---

## Figure 4: ECA Polling Loop

Manuscript source: Table 6 (Policy Execution Matrix) and "Conflict Resolution and Execution Precedence".
Order is the **precedence hierarchy**, not the table order: POL-01 → POL-05/06/07 → POL-02/03 → POL-08.

```mermaid
flowchart TD
    START(["Polling cycle start"]) --> ACQ["Acquire data<br/>PZEM-004T: V, I, W<br/>ZMCT103C: P_branch_i"]
    ACQ --> CTX["Build context snapshot<br/>P_total · P_branch_i · O_relay_i<br/>fetch O_priority_i and P_limit<br/>from Policy Repository"]
    CTX --> P1{"POL-01<br/>S_fault == TRUE?"}

    P1 -- "Yes" --> FAULT["ACT_FAULT<br/>open all relays, isolate system,<br/>set critical lockout"]
    FAULT --> LOG1["Write fault to /logs/events"]

    P1 -- "No" --> P5{"POL-05 / 06 / 07<br/>P_total > P_limit?"}
    P5 -- "Yes" --> SHED["Selective Load Response Protocol<br/>(see Figure 6)"]
    SHED --> SUPPRESS["Suppress pending<br/>branch activation requests"]
    P5 -- "No" --> P2{"POL-02 / POL-03<br/>Activation request and<br/>mathematical headroom?"}

    P2 -- "Yes, P_total < P_limit" --> ALLOW["ACT_ALLOW(i)<br/>close relay i"]
    ALLOW --> POL4["POL-04 post-activation check<br/>after 500 ms inrush stabilisation"]
    POL4 --> POL4Q{"P_total > P_limit?"}
    POL4Q -- "Yes" --> SHED1["ACT_SHED(i)<br/>isolate the offending load"]
    POL4Q -- "No" --> ACTIVE["Node i confirmed active"]

    P2 -- "No" --> P8{"POL-08<br/>P_branch_i below standby threshold<br/>for longer than T?"}
    P8 -- "Yes" --> STANDBY["ACT_SHED(i)<br/>standby disconnection"]
    P8 -- "No" --> NEXT

    ACTIVE --> NEXT
    SHED1 --> NEXT
    STANDBY --> NEXT
    LOG1 --> NEXT

    NEXT["Push telemetry to Firebase<br/>P_total · relay states · fault flags<br/>append /logs/events"] --> LOOP(["Next polling cycle"])
    LOOP -.->|"continuous"| ACQ
```

---

## Figure 5: Branch Activation & Verification Sub-Routine

Manuscript source: §3.5 "Branch Activation & Verification Sub-Routine", POL-02 → POL-03 → POL-04.
The 500 ms stabilisation delay is mandatory — do not shorten it in the diagram, it is the inrush window.

```mermaid
flowchart TD
    REQ(["Activation request for node i"]) --> ASSESS["POL-02 Pre-Activation Assessment<br/>verify mathematical headroom"]
    ASSESS --> HEAD{"P_total < P_limit?"}

    HEAD -- "No" --> DENY["ACT_DENY(i)<br/>relay i stays open<br/>log: insufficient capacity"]
    DENY --> END1(["Return to polling loop"])

    HEAD -- "Yes" --> ALLOW["ACT_ALLOW(i)<br/>close relay i"]
    ALLOW --> DELAY["Mandatory 500 ms<br/>inrush stabilisation delay"]
    DELAY --> VERIFY["POL-04 Post-Activation Verification<br/>re-read P_total"]
    VERIFY --> OVER{"P_total > P_limit?"}

    OVER -- "Yes" --> SHED["ACT_SHED(i)<br/>immediately isolate the<br/>hazardous load<br/>log shedding event"]
    SHED --> SAFE(["Lab grid protected"])

    OVER -- "No" --> OK["Node i confirmed active<br/>update /outlets/node_i/relay_state"]
    OK --> END2(["Return to polling loop"])
```

---

## Figure 6: Selective Load Response Protocol

Manuscript source: §3.5 "Selective Load Response Protocol" narrative — shedding is **sequential**, to prevent
cascading failure and relay oscillation; priority-3 nodes are insulated by POL-07.

```mermaid
flowchart TD
    TRIG(["Trigger: P_total > P_limit"]) --> PRES["POL-07 Priority Preservation<br/>ACT_PRESERVE(i) where O_priority_i == 3<br/>high-priority loads are insulated"]
    PRES --> SETLOCK["Set lockout_flag on<br/>candidate shed nodes"]
    SETLOCK --> L1["POL-05 Level 1<br/>ACT_SHED(i) where O_priority_i == 1<br/>low-priority nodes"]

    L1 --> D1["Stabilisation delay"]
    D1 --> R1{"Re-read P_total<br/>still over limit?"}
    R1 -- "No" --> RECOVER["Overload resolved<br/>clear lockout flags, resume normal polling"]
    RECOVER --> END1(["Return to polling loop"])

    R1 -- "Yes" --> L2["POL-06 Level 2<br/>ACT_SHED(i) where O_priority_i == 2<br/>medium-priority nodes"]
    L2 --> D2["Stabilisation delay"]
    D2 --> R2{"Re-read P_total<br/>still over limit?"}
    R2 -- "No" --> RECOVER

    R2 -- "Yes" --> ALERT["All shedtable loads already shed;<br/>P-3 loads preserved per POL-07.<br/>Log over-limit condition and<br/>raise alert on the dashboard"]
    ALERT --> END2(["Return to polling loop —<br/>await administrative action"])
```

---

## Notes for whoever pastes these in

1. **Figure 4 vs Figure 6 overlap.** Figure 4 deliberately contains one collapsed node
   ("Selective Load Response Protocol — see Figure 6"). Keep the reference; it saves a cluttered page and the
   two figures then read as overview + detail.
2. **Precedence order is load-bearing.** In Figure 4 the order is POL-01 → threshold response →
   pre-activation → standby. This is *not* the numeric order of Table 6 and a reader who assumes it is will
   misread the firmware. If the panel asks, this is the answer from §"Conflict Resolution and Execution
   Precedence".
3. **`P_limit` is named two ways in the manuscript** — 2500 W in §"Power Rating and Operating Limit" and
   `system_limit_amps` in Table 3. The diagrams use `P_limit` throughout; keep the manuscript's own
   definition sentence when the figure is discussed.
4. **List of Figures is out of date.** The front-matter LoF lists Figures 7–11 and 14, 17, 18, 19 but omits
   **12, 13, 15, 16**, which do exist in the body. Regenerate the LoF when the figures are final.
5. **Figure 1** (Conceptual Diagram of the Proposal) belongs to Chapter 1, not the methodology set, so it is
   not included here.
