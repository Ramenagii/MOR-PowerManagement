# Chapter 3 — GPT Methodology Figures, ported to the Ch. 3 Revision tab

Source of the **figure concepts**: Google Doc tab **"GPT"** (`t.h4q2fhjexsk1`), Figures 2–6.
Target: the live manuscript in tab **"Ch. 3 Revision"** (`t.13td6aj76ye4`).

**Hardware binding is Ch. 3 Revision's, not GPT's — read this before using the diagrams.**
GPT's text specifies a nine-unit configuration (`AC1–AC7`, `AUX110`, `USB-G`) and an `ADS1015`.
Ch. 3 Revision specifies **six AC branches** and an **ADS1115**. Porting GPT's figures verbatim would put
`ADS1015` and "nine outputs" into a manuscript whose own text says six branches and ADS1115.
These diagrams therefore keep GPT's *structure and intent* and are bound to the build you actually have.
**If you are building the nine-unit configuration, tell me and I will regenerate this set.**

## Numbering — resolve before inserting

Ch. 3 Revision already owns Figures 2–6, and so does GPT. Inserting these without renumbering collides.
Suggested insertion, keeping your existing 3D (7–13) and UI (14–19) figures intact at the end:

| New | GPT name | Current number it displaces |
|---|---|---|
| Figure 7 | Iterative Research and Development Process | old 7–13 → 12–18 |
| Figure 8 | Hardware Input–Process–Output Block Diagram with Feedback | |
| Figure 9 | Software Architecture and Final Hardware Boundary | old 14–19 → 19–24 |
| Figure 10 | Current Sensing and Dashboard Process | |
| Figure 11 | Proposed System Input–Process–Output Flowchart | |

Also regenerate the List of Figures — the current one already omits Figures 12, 13, 15, 16.

---

## Figure 7 — Iterative Research and Development Process

GPT §3.2: requirements and design alternatives inform each implementation increment; unmet acceptance
criteria return the increment to specification and correction; completed increments support subsequent
integration, user assessment, and reporting.

```mermaid
flowchart TD
    REQ(["Site assessment and requirements<br/>equipment inventory, circuit limits, user practices"]) --> ALT["Design alternatives<br/>rated against constraints"]
    ALT --> INC(["Implementation increment"])
    INC --> EVAL["Evaluation<br/>reproducible rule tests, measurement vs reference instrument,<br/>switching and communication tests, expert review"]
    EVAL --> ACC{"Acceptance criteria<br/>met?"}
    ACC -- "No" --> SPEC["Specification and correction<br/>return the increment to specification"]
    SPEC --> INC
    ACC -- "Yes" --> NEXTINC(["Next increment"])
    NEXTINC --> INC
    NEXTINC --> INT["Integration<br/>hardware and software integration testing"]
    INT --> UA["User assessment<br/>ISO/IEC 25010 user-perception survey"]
    UA --> REP["Report evaluated prototype<br/>and remaining limitations"]
    REP --> DONE(["Projected deployment"])
```

---

## Figure 8 — Hardware Input–Process–Output Block Diagram with Feedback

GPT's key instruction: the feedback path is **the electrical response of the connected loads**, not a
database status arrow. That distinction is the whole reason the figure exists.

```mermaid
flowchart LR
    subgraph IN["INPUTS"]
        direction TB
        MAINS(["AC mains supply"])
        LOAD(["Connected peripheral loads"])
        OPER(["Operator configuration and requests"])
    end

    subgraph PROC["ACQUISITION, DECISION AND CONTROL"]
        direction TB
        PROT["10 A fuse and 300 V varistor<br/>overcurrent and spike protection"]
        PZ["PZEM-004T<br/>aggregate V, I, W"]
        SPLIT{"Six switched branches"}
        BR["Branch i, i = 1 … 6<br/>ZMCT103C current sensor<br/>5 V relay and socket"]
        ADC["ADS1115<br/>16-bit ADC"]
        MCU["ESP32-S3<br/>ECA policy engine<br/>POL-01 … POL-08"]
    end

    subgraph OUT["OUTPUTS"]
        direction TB
        SOCK(["Six switched socket outlets<br/>controlled connection or interruption"])
    end

    MAINS --> PROT
    PROT --> PZ
    PZ --> SPLIT
    SPLIT --> BR
    BR --> ADC
    ADC --> MCU
    MCU -->|"relay command"| BR
    SPLIT --> SOCK
    LOAD -->|"plugged in"| SOCK
    OPER -.->|"policy and priority"| MCU

    BR -.->|"FEEDBACK: electrical response of the connected load"| ADC
```

> The dashed edge is the feedback the panel will look for. It is deliberately **not** drawn as a status
> arrow from the database — that was GPT's stated correction to the earlier diagram style.

---

## Figure 9 — Software Architecture and Final Hardware Boundary

GPT's purpose: stop the conceptual framework diagram being read as an implementation diagram, and show
which parts of the architecture are *outside* the physical device.

```mermaid
flowchart TB
    subgraph DEVICE["INSIDE THE DEVICE BOUNDARY — ESP32-S3 firmware"]
        DRV["Sensing driver<br/>PZEM-004T, ZMCT103C<br/>via ADS1115"]
        ECA["ECA policy engine<br/>POL-01 … POL-08<br/>precedence hierarchy"]
        RLY["Relay driver<br/>GPIO, actuation"]
        CONN["Wi-Fi client<br/>Firebase RTDB"]
        DRV --> ECA
        ECA --> RLY
        ECA --> CONN
    end

    subgraph CLOUD["OUTSIDE THE DEVICE — Firebase backend"]
        REPO[("Policy Repository<br/>P_limit, priority_level,<br/>standby timeout")]
        TEL[("Telemetry store<br/>P_total, relay states")]
        LOG[("Event log<br/>activation denied, load shed")]
        AUTH["Configuration validation<br/>outlet roles: instructor-use,<br/>student-use, general-use"]
        AUTH --> REPO
    end

    subgraph CLIENT["OUTSIDE THE DEVICE — browser dashboard"]
        UI["Configuration UI<br/>priority, limits, schedules"]
        MON["Live monitoring<br/>total and branch load,<br/>outlet state, event history"]
        UI --> AUTH
    end

    CONN <-->|"HTTPS"| TEL
    CONN <-->|"HTTPS"| REPO
    CONN -->|"HTTPS"| LOG
    TEL --> MON
    LOG --> MON
    REPO -.->|"validated configuration"| CONN
```

> Dashed edges are remote configuration paths; solid edges are local processing. Only the **DEVICE**
> subgraph is the hardware boundary — the adviser asked for that distinction to be drawn explicitly.

---

## Figure 10 — Current Sensing and Dashboard Process

Three lanes: embedded device, backend, browser. Dashed arrows are HTTP transfers between independently
executing components. This figure states **present** behaviour; Figure 11 states **required** behaviour.

```mermaid
flowchart LR
    subgraph DEVL["EMBEDDED DEVICE"]
        direction TB
        D0(["Start"]) --> D1[/"Read PZEM-004T and ZMCT103C"/]
        D1 --> D2["Compute P_total and P_branch_i"]
        D2 --> D3[/"Push telemetry"/]
        D3 --> D4[/"Poll /config for policy changes"/]
        D4 --> D5["Apply POL-01 … POL-08"]
        D5 --> D6[/"POST relay command and event"/]
    end

    subgraph BACK["BACKEND"]
        direction TB
        B1[("Accept telemetry payload")]
        B2[("Write /telemetry")]
        B3["Write /logs/events"]
        B4["Validate role and configuration change"]
        B5[("Update /config and /outlets")]
    end

    subgraph BROWSER["BROWSER DASHBOARD"]
        direction TB
        R1["Submit priority, limit or schedule change"]
        R2["Render live load and outlet state"]
    end

    D3 -.->|"HTTP POST"| B1
    B1 --> B2
    D6 -.->|"HTTP POST"| B3
    R1 -.->|"HTTP"| B4
    B4 --> B5
    B5 -.->|"HTTP"| D4
    D1 -.->|"HTTP read"| R2
    B2 -.->|"HTTP read"| R2

    R2 --> D0
```

> **Known limit to state in the caption, not hide:** a displayed disconnection is a database outcome,
> not proof of a physical action, and later telemetry can reconcile a non-restricted record back to
> Active/Standby. GPT flagged this explicitly. Figure 11 is the required behaviour that closes the gap.

---

## Figure 11 — Proposed System Input–Process–Output Flowchart

> **Revised after verification.** The first draft used GPT's output-state vocabulary
> (`Activation-Pending`, `ON-Unverified`, `ON-Verified`, `Fault/Restricted`) and a
> priority/contribution tie-break rule. Verified against the Ch. 3 Revision tab: every one of those
> terms occurs **zero times**, and Table 5 defines only *action* identifiers. That version was not
> justifiable from your Chapter 3, so it has been rewritten below using only constructs your
> manuscript actually defines — POL-01…POL-08, the ACT_* action space, `P_total`/`P_limit`,
> the 500 ms inrush stabilisation, and the precedence hierarchy.
>
> If you *want* the richer state model, it has to be written into §3.5.1.3 first, and then this
> figure can be redrawn to match. A figure cannot be the only place a design exists.

Inputs and authorization on the left, validity checks and activation in the centre, selective response
and physical verification on the right.

```mermaid
flowchart LR
    subgraph L["INPUTS AND CONFIGURATION"]
        I1[/"Aggregate measurement<br/>PZEM-004T"/]
        I2[/"Branch measurement<br/>ZMCT103C, node i"/]
        I3[/"Operator configuration<br/>outlet role and O_priority_i"/]
        I4[/"Idle timer<br/>standby_timeout_min"/]
        POL["Policy Repository<br/>P_limit, priority_level,<br/>standby timeout"]
        I3 --> POL
        POL --> I1
    end

    subgraph M["VALIDITY AND ACTIVATION - precedence tiers 1 and 3"]
        V1{"POL-01<br/>S_fault == TRUE?"}
        V2["ACT_FAULT<br/>open all relays, isolate,<br/>set lockout flags"]
        V3{"POL-02 / POL-03<br/>headroom available?"}
        V4["ACT_ALLOW(i)<br/>close relay i"]
        V5["ACT_DENY(i)<br/>log insufficient capacity"]
        V6["POL-04<br/>wait 500 ms inrush stabilisation,<br/>re-read P_total"]
        V7{"P_total > P_limit?"}
        V8["ACT_SHED(i)<br/>isolate the offending load"]
        V1 -- "Yes" --> V2
        V1 -- "No" --> V3
        V3 -- "Yes" --> V4 --> V6 --> V7
        V3 -- "No" --> V5
        V7 -- "Yes" --> V8
    end

    subgraph R["SELECTIVE RESPONSE - precedence tier 2"]
        S1{"POL-05 / POL-06 / POL-07<br/>P_total > P_limit?"}
        S2["ACT_SHED(i) where O_priority_i == 1<br/>low priority first"]
        S3{"Over limit<br/>after stabilisation?"}
        S4["ACT_SHED(i) where O_priority_i == 2<br/>medium priority"]
        S5["ACT_PRESERVE(i) where O_priority_i == 3<br/>high priority insulated"]
        S6["POL-08 standby management<br/>ACT_SHED(i) after idle timeout"]
        S1 -- "Yes" --> S2 --> S3
        S3 -- "Yes" --> S4 --> S5
        S1 -- "No" --> S6
    end

    OUT["Push telemetry to Firebase<br/>P_total, P_branch_i, relay states,<br/>fault and lockout flags"]
    LGN[("Write /logs/events<br/>ACTIVATION_DENIED, LOAD_SHED")]

    I1 --> V1
    I2 --> V1
    I4 --> S6
    V1 --> OUT
    V2 --> OUT
    V3 --> OUT
    V4 --> OUT
    V5 --> OUT
    V6 --> OUT
    V7 --> OUT
    V8 --> OUT
    S1 --> OUT
    S2 --> OUT
    S3 --> OUT
    S4 --> OUT
    S5 --> OUT
    S6 --> OUT
    OUT --> LGN
    V5 --> LGN
    V8 --> LGN
    S2 --> LGN
    S4 --> LGN
```

> Connectors **A**, **V**, **L** are Mermaid-only labels standing in for the off-page connectors GPT
> specifies in Appendix I. Keep them identical across Figures 10 and 11 so the two connect.

---

## Caption guidance

Adviser item 3.3 requires a textual discussion for every figure. Write one short paragraph per figure
stating: what the figure shows, what feedback path it depicts, and what it does **not** claim about the
current build. GPT's Figures 5 and 6 are the model — 5 says what the system does now, 6 says what it must
do, and neither is allowed to imply unimplemented behaviour is working.
