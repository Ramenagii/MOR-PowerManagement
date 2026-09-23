# MOR — Chapter 1 Revisions (Paste-Ready)

> **Terminology decision (agreed):** All references to "policy"/"enforcement" replaced with the **Framework** framing:
> - "Usage Policy" → **Usage Management Framework** / **framework**
> - "Policy Decision Point (PDP)" → **Decision Point (DP)**
> - "Policy Enforcement Point (PEP)" → **Execution Point (EP)**
> - "Policy Execution Matrix" → **Framework Execution Matrix**
> - "enforce" → **apply / execute / manage**
> - Rule identifiers "POL-01...POL-08" → **FR-01 ... FR-08**
>
> What goes where in Ch.1:
> - Scope & Limitations → expanded with design consideration + 110V/USB + no-damage
> - NEW subsection: System Constraints (what the device cannot do)
> - Definition of Terms → revised with operational definitions (framework framing)
> Replace **[bracketed bold]** with your actual lab data.

---

## REVISION 1: Scope and Limitations (REPLACE existing section in Ch.1)

**Scope and Limitations of the Study**

This study focuses on the design and development of a custom-built Power Management Extension with context-aware selective load response and a usage management framework for shared laboratory classrooms in the Computer Engineering Department.

**Design Consideration**

The physical form-factor of the proposed device was determined by surveying the actual layout and working conditions of the Computer Engineering laboratory, rather than assuming a preferred configuration. Three candidate form-factors were evaluated: (A) a standard flat power strip, (B) a tower-type vertical power post, and (C) a compact receptacle-block extender. The tower-type design was adopted because the laboratory uses shared workstation tables where horizontal desk space is limited and multiple devices — computers, monitors, chargers, and peripherals — must share a single energized point. The tower concentrates six rated outlet channels in a stable, low-tip-over base while occupying minimal horizontal footprint.

A key institutional constraint governs all physical designs: laboratory policy requires that **no structural damage or permanent modification** be performed on the interior — no drilling into walls or partitions, no permanent re-wiring of the building electrical panel, and no adhesive mounting that could leave residue on laboratory furniture. The adopted design satisfies this by using a **plug-in, surface-standing configuration**: the device connects at the existing wall outlet and rests freely on the desk without any fastener or modification to the laboratory infrastructure.

A technical walkthrough of the laboratory was conducted to verify: outlet type and location, available desk clearance per workstation, and the arrangement of existing extension strips. These findings informed the final dimensions, channel count, and placement of the unit.

**Electrical Rating and Compatibility**

The proposed system is specified to operate within the standard Philippine low-voltage supply of **220–240 V AC, 50–60 Hz**. Each controlled outlet channel is rated for at least 250 V AC / 10 A, yielding a maximum reference load of approximately **2,200 W** at 220 V AC. The system software limit is set at **2,500 W** with a physical 10 A glass fuse as a backstop.

To broaden compatibility with devices found in shared laboratory settings, two additional output types are incorporated:

(a) **110 V AC auxiliary socket** — a single step-down transformer module (rated ≥ 150 VA) accommodates imported or legacy equipment that requires 110 V input. This output is separately fused and labeled; it is excluded from the prioritized load-shed logic and is reported to the dashboard for transparency.

(b) **USB 5 V charging ports** — two USB-A ports (5 V, 2.1 A each) via a buck converter module provide charging for smaller mobile devices including phones and tablets. These are galvanically isolated from the controlled outlet channels and are powered from the internal 5 V supply rail.

These auxiliary outputs are provided so that students can safely charge personal devices without occupying controlled outlet channels reserved for rated laboratory equipment.

**System Scope**

The proposed system provides extension-level power monitoring, outlet-level control, and priority-based Demand-Side Management (DSM) utilizing properly rated terminal blocks, protective elements, and components rated for at least 250 V AC and 10 A. A decoupled architecture is employed: a web dashboard acts as the centralized Decision Point (DP) allowing authorized personnel to dynamically configure extension-level operating thresholds and assign specific priority levels to individual outlets without altering the embedded firmware. The ESP32-S3-WROOM microcontroller serves as the Execution Point (EP), executing framework rules locally while synchronizing with the dashboard via a backend API backed by a Neon PostgreSQL database. The system is designed for a single-tower prototype with six controlled outlet channels, one 110 V auxiliary socket, and two USB 5 V ports.

---

## REVISION 2: System Constraints and Non-Functionalities (NEW subsection — place AFTER Scope & Limitations)

The Power Management Extension is a switching, scheduling, and rule-management device. It is **not** a power-conditioning, energy-storage, or power-reduction device. The following explicitly define what the system **cannot** do, to ensure that expectations are set within its actual capabilities:

**1. Cannot reduce or limit power intake like an inverter or variable-frequency drive.**
The device cannot step down, shape, or convert the main incoming current. Energy savings arise solely from the disconnection of idle, standby, or lower-priority loads — not from electrical power conversion or conditioning.

**2. Cannot regulate or condition main voltage for the load.**
The 220–240 V AC pass-through is unregulated. Voltage and current are continuously sensed and reported, but are not corrected or stabilized by the device. The 110 V and 5 V auxiliary outputs are fixed converters, not mains power conditioners.

**3. Cannot provide uninterruptible power or brownout ride-through.**
The device contains no energy storage (battery, capacitor bank, or UPS module). During a power outage, brownout, or supply interruption, all controlled outlets and auxiliary outputs drop out simultaneously and restore only when stable supply returns.

**4. Cannot support air-conditioning, high-wattage industrial, or motor-heavy loads beyond rating.**
The per-unit reference load is approximately 2,200 W and the system software limit is 2,500 W. Any load approaching or exceeding these limits will trip the fuse or circuit breaker. Air-conditioning units, welding equipment, and heavy machinery are explicitly outside the operating envelope.

**5. Cannot rewire, replace, or protect the building electrical panel.**
The device is a plug-in extension. It protects and manages its own connected outlets only; it cannot protect the fixed branch circuit upstream of the wall outlet into which it is plugged.

**6. Cannot fully operate without a network connection.**
Remote control, live telemetry display, and administrator configuration through the dashboard require a stable Wi-Fi connection to the backend cloud API. In offline mode, the embedded firmware applies the last-known local framework rules, but remote reconfiguration and real-time dashboard updates are unavailable.

**7. Cannot identify individual users or authenticate identities.**
User context is inferred from schedules, outlet priority assignments, and load profiles — not via biometric, RFID, or token-based identification.

---

## REVISION 3: Definition of Terms (REPLACE existing section in Ch.1)

**Definition of Terms**

The following terms are defined both conceptually and operationally as used in this study:

**Usage Management Framework** — *Conceptually,* an architecture for governing the behavior of a system through a set of rules, decision logic, execution mechanisms, and a configuration interface. *Operationally,* in this study, the complete structure comprising the Decision Point (dashboard), the Execution Point (ESP32 firmware), the framework rules (FR-01 to FR-08), the ECA evaluation loop, the precedence/conflict-resolution hierarchy, and the backend configuration store (Neon PostgreSQL) — working together to manage outlet behavior in a shared laboratory.

**Branch Load** — The specific, isolated electrical current being drawn by a single connected device at an individual outlet channel. *Operationally:* the current reading obtained from the ZMCT103C sensor assigned to that channel in the prototype.

**Context-Aware** — A computing paradigm in which a system continuously gathers data about the state of its environment and uses that data to autonomously adapt its behavior without manual intervention. *Operationally:* the ESP32 reads sensor data (current, voltage, load, time) and automatically executes the appropriate framework action (allow, block, shed, or preserve) on each outlet channel.

**Decision Point (DP)** — *Operationally:* the web dashboard and backend API configuration nodes (Neon PostgreSQL) where the laboratory administrator sets operational thresholds, outlet priorities, and scheduling rules.

**Execution Point (EP)** — *Operationally:* the ESP32-S3 firmware that reads the framework configuration and executes the corresponding action (ACT_ALLOW, ACT_BLOCK, ACT_SHED, ACT_PRESERVE, or ACT_FAULT) during each polling cycle.

**Event-Condition-Action (ECA)** — A rule structure in which a defined event triggers evaluation of a condition, and if the condition is true, a specified action is executed. *Operationally:* the continuous polling loop (Figure 4) in which the ESP32 evaluates FR-01 through FR-08 each cycle.

**Selective Load Shedding** — The automated, targeted disconnection of specific lower-priority outlets to reduce total aggregate current draw, while higher-priority outlets remain powered. *Operationally:* FR-05 (shed low-priority) → FR-06 (shed medium-priority) with FR-07 preserving high-priority channels.

**Framework Rule** — *Operationally:* a machine-executable rule (FR-01 to FR-08) configured through the Decision Point that governs outlet access, priority, and standby management, executed by the Execution Point.

**Standby / Idle Load** — A connected device drawing below a defined threshold for a sustained period. *Operationally:* any branch whose current remains below the standby threshold for more than 30 minutes, triggering FR-08 for automatic disconnection.

**Total Aggregate Load (P_total)** — *Operationally:* the sum of all connected branch loads as read by the PZEM-004T master meter at the extension input.

**Auxiliary Output** — *Operationally:* the 110 V AC step-down socket and the 5 V USB charging ports, which are separate from the six controlled outlet channels and are not subject to the load-shed logic.

**Load Shedding** — *Operationally:* the physical act of opening a relay to disconnect an outlet channel, executed by the firmware in response to a load-shed rule being triggered.

**ISO/IEC 25010** — An international software quality model defining criteria for measuring software product quality. *Operationally:* used as the structural basis for the user perception survey evaluating functionality, reliability, interaction capability, and flexibility of the proposed system.

---

## REVISION 4: Central Tendency (REPLACE the existing Statistical Treatment central tendency paragraph in Ch.3)

**Measures of Central Tendency**

This study applies measures of central tendency differently depending on the data source, as recommended for survey-based and prototype-based research.

**For the User Perception Survey (ISO 25010, Likert scale):**
- **Weighted Mean (arithmetic mean):** the primary measure summarizing the typical acceptability score per variable and overall. It provides the central value used for interpretation against the established scale.
- **Median:** reported alongside the mean to identify any skewness in the response distribution, particularly when respondents cluster at scale extremes.
- **Mode:** reported as the most frequently chosen Likert level for each item, providing additional context for interpreting consensus among respondents.
- Interpretation follows the established scale: 4.21–5.00 = Strongly Agree / Excellent; 3.41–4.20 = Agree; 2.61–3.40 = Neutral; 1.81–2.60 = Disagree; 1.00–1.80 = Strongly Disagree.

**For Prototype Technical Testing (sensor accuracy, response time, functionality %):**
- **Arithmetic Mean:** the primary measure for performance metrics (e.g., mean percentage error, mean accuracy, mean response time). It represents the typical measured value across repeated trials.
- **Median:** used alongside the mean to detect the influence of outlier readings (e.g., occasional relay lag or sensor noise spikes). If the median deviates markedly from the mean, the median is treated as the more robust central value for that metric.
- **Standard Deviation:** quantifies the consistency of measurements around the mean for both survey and prototype testing data.

---

## REVISION 5: Block Diagram — Hardware Only, IPO + Feedback (REPLACE Figure 3 description / redraw)

> This revision replaces the existing block diagram (Figure 3). The revised diagram is **hardware-only** (no survey, no conceptual boxes), shows **Input → Process → Output** with a **feedback loop** closing from output back to process — making the system a closed-loop control system.
>
> **Terminology:** "Decision Point (DP)" replaces PDP; "Execution Point (EP)" replaces PEP; rules are "FR-01 to FR-08".

**Figure 3: Hardware Block Diagram of the Proposed System (Input–Process–Output, Closed-Loop)**

```
┌─────────────────────────────────┐
│           INPUT                 │
│  ────────────────────────────   │
│  PZEM-004T                     │
│   (Total V, I, W)              │
│                                │
│  6× ZMCT103C                   │
│   (Branch current per channel) │
│                                │
│  ADS1115                       │
│   (Precision ADC for ESP32)    │
│                                │
│  Per-channel manual switches   │
│                                │
│  10A glass fuse + MOV          │
│   (Input protection)           │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│           PROCESS               │
│  ────────────────────────────   │
│  ESP32-S3-WROOM                │
│   • Polls sensors each cycle   │
│   • Runs ECA logic (FR-01–08)  │
│   • Resolves conflict by       │
│     precedence hierarchy       │
│   • Drives relay outputs       │
│   • Syncs with backend DP      │
│     via WiFi                   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│           OUTPUT                │
│  ────────────────────────────   │
│  6× Relay → 220-240V outlets   │
│  1× 110V step-down socket      │
│  2× USB 5V ports               │
│  Status LEDs / Buzzer          │
└──────────────┬──────────────────┘
               │
               │  FEEDBACK
               │  (measured P_total, P_branch
               │   returned to ESP32 for
               │   re-evaluation each cycle)
               │
               ▼
      Back to PROCESS (closed loop)
```

**Input:** PZEM-004T (total voltage, current, wattage), 6× ZMCT103C (branch-level current per outlet), ADS1115 (external precision ADC to mitigate ESP32 ADC noise), per-channel manual switches, and 10 A glass fuse + MOV (protection at AC input).

**Process:** ESP32-S3-WROOM continuously samples all sensors, executes the ECA polling loop, resolves framework conflicts using the precedence hierarchy, drives relay states, and synchronizes configuration with the Firebase Decision Point via WiFi.

**Output:** Six relay-controlled 220–240 V AC outlet channels, one 110 V auxiliary socket, two USB 5 V ports, and status indicators (LEDs, optional buzzer).

**Feedback (Closed Loop):** the measured P_total and P_branch values are fed back into the next ECA cycle so the system re-evaluates conditions after each action — for example, post-activation verification (FR-04) re-measures total load after a relay closes and triggers load shedding (FR-05/06) if the limit is exceeded. This closed-loop feedback differentiates the system from a simple open-loop timer or switch.

---

## REVISION 6: SDLC Determination (ADD as a new section in Ch.3 Methodology, after Research Design)

**Software Development Life Cycle (SDLC)**

The study adopts the **Iterative Prototyping Model** as its Software Development Life Cycle.

The Iterative Prototyping Model was selected over alternative SDLC models for the following reasons:

- **Waterfall:** a linear, sequential model in which each stage must be completed before the next begins. This is unsuitable for hardware-integrated systems where early-stage sensor or relay decisions cannot be validated without building and testing physical prototypes. Discovering a fault late in the Waterfall sequence would require returning to earlier stages, negating its primary advantage.

- **V-Model:** a verification-and-validation extension of Waterfall that maps each development stage to a corresponding test stage. While strong for formal software verification, the model assumes a complete requirements specification at the outset, which does not align with the iterative, exploratory nature of hardware prototyping where component behavior under real mains-voltage conditions is discovered during testing.

- **Big Bang:** a model in which development proceeds without a defined structure and all testing occurs at the end. Given the safety implications of a 220 V mains-voltage device, deferring all validation to the final stage is unacceptably risky.

- **Agile / Scrum:** while Agile's iterative philosophy is relevant, pure Agile sprints are designed for software teams with rapid release cycles. Hardware fabrication, enclosure 3D-printing, and component procurement timelines do not align with fixed sprint cadences.

The Iterative Prototyping Model fits the study because the research design already follows a **design → build → test → evaluate → refine** loop (see Figure 2). Each prototype iteration is tested against defined performance thresholds (sensor accuracy, response time, stability), and if thresholds are not met, the design is refined and retested before the next evaluation cycle. This model provides the structured feedback loop of Agile while accommodating the longer iteration times inherent to hardware development.

**Process flow (as implemented):**
1. Define objectives, scope, and limitations.
2. Analyze existing solutions and identify the research gap.
3. Design system architecture (circuit, firmware, enclosure).
4. Build hardware prototype.
5. Conduct technical evaluation (sensor accuracy, response time, functionality, stability).
6. If evaluation is unsuccessful → revise design → return to step 3 or 4 → retest.
7. If evaluation is successful → conduct user evaluation (ISO 25010 survey).
8. If user evaluation is unsuccessful → refine → return to step 3.
9. Finalize and complete.

---

## REVISION 7: Figure Discussions (ADD under every figure in the paper)

Format template per figure:
> **Figure N: [Title].** This figure shows [...]. It is included to [...]. The panel should note [...] / What was observed: [...].

- **Figure 1 – Conceptual Diagram:** explains the research framework (input → process → output + feedback) and where the knowledge/hardware/software requirements map. Purpose: shows the theoretical position of the device.
- **Figure 2 – Process Flowchart:** shows the Iterative Prototyping SDLC actually followed (design → prototype → evaluate → refine loop). Purpose: proves developmental rigor.
- **Figure 3 – Block Diagram:** hardware-only IPO with feedback — see Revision 5. Purpose: single-glance view of system topology.
- **Figure 4 – ECA Polling Loop:** the firmware's continuous detect→decide→act cycle. Purpose: explains how real-time context is achieved.
- **Figure 5 – Branch Activation & Verification Sub-Routine:** the allow→stabilize→re-measure→(shed/keep) logic. Purpose: shows post-activation safety.
- **Figure 6 – Selective Load Response Protocol:** shedding sequence FR-05→FR-06 with high-priority preservation (FR-07). Purpose: demonstrates load shedding is selective, not blanket.
- **Figures 7–13 (3D / Isometric design):** enclosure internals (bottom shell, AC distribution & protected switching, outlet wells & 3-pole blocks, isolated LV controller bay, top cover, isometric views). Purpose: shows mechanical/electrical compartment separation and flame-retardant, serviceable casing.
- **Figures 14–19 (Dashboard PC + Mobile views):** dashboard, hardware, framework rules layouts. Purpose: demonstrates the DP interface for administrator configuration and real-time monitoring across desktop and mobile.

---

## REVISION 8: Flowchart (REVISE — input-first, standard symbols, one page landscape)

**Figure: System Operation Flowchart — Input → Process → Output (one page, landscape, small image, standard symbols)**

**Symbols used (legend on the figure):**
- **Oval** — Start / End
- **Rectangle** — Process / Action
- **Parallelogram** — Input / Output data
- **Diamond** — Decision / Condition
- **Arrows** — Flow direction

**Flow (start with the person/input first):**
1. **[Start (Oval)]**
2. **[Input (Parallelogram)] Person plugs a device into an outlet channel / presses a manual switch OR a scheduled/activation request is received.**
3. **[Process] ESP32 synchronizes framework configuration from Dashboard (DP).**
4. **[Process] Read sensors: PZEM-004T (P_total) + ZMCT103C per branch (P_branch).**
5. **[Decision (Diamond)] S_fault == TRUE?**
   - Yes → **[Process] ACT_FAULT: open all relays, lockout (FR-01)** → logging → loop.
   - No → continue.
6. **[Decision] Pre-activation request? And P_total < P_limit? (FR-02 / FR-03)**
   - No capacity → **[Process] ACT_BLOCK (log insufficient capacity)** → return to loop.
   - Yes → **[Process] ACT_ALLOW: close relay, 500 ms stabilization delay**.
7. **[Process] Post-activation re-measure P_total (FR-04).**
8. **[Decision] P_total > P_limit?**
   - No → continue normal monitoring (standby check FR-08).
   - Yes → **[Process] Load Shedding Level 1: ACT_SHED low-priority (FR-05)**; wait; re-measure.
9. **[Decision] Overload cleared?**
   - No → **[Process] Load Shedding Level 2: ACT_SHED medium-priority (FR-06)**; ACT_PRESERVE high-priority (FR-07).
10. **[Output (Parallelogram)] Publish relay states + telemetry to the backend API / dashboard (Neon PostgreSQL).**
11. **[Process] Standby check: any branch < threshold for >30 min? (FR-08)** → shed.
12. **[Decision] Continue / Shutdown?**
    - Continue → loop to step 3.
    - **[End (Oval)]** after shutdown/off command.

Formatting: fit on **one page**, set page to **landscape**, keep the image **small** (about 1/2 to 2/3 page), include the **symbol legend**, each diamond has explicit **Yes/No** labels.

---

## REVISION 9: Multiple Constraints (Appendix A — place at end of paper)

### Appendix A: Multiple Constraints

#### A.1 Design Constraints

Three candidate physical form-factors were evaluated before the final design was selected:

| Criterion | Design A: Flat Power Strip | Design B: Tower Type | Design C: Compact Receptacle Block |
|---|---|---|---|
| Outlet channels possible | 2–4 (insufficient for 6-channel spec) | 6 (sufficient) | 2–3 (insufficient) |
| Horizontal desk footprint | Large | **Small** | Small |
| Stability when multiple plugs inserted | Moderate (tips under uneven load) | **High (wide base, low center of gravity)** | Low (top-heavy) |
| Separates LV controller from AC bus | Difficult in flat casing | **Good — isolated LV bay** | Difficult |
| Serviceability | Limited access to internals | **Accessible internal tray** | Limited |
| Fits no-interior-damage policy | Yes (plug-in, surface) | Yes (plug-in, surface) | Yes |
| **Decision** | ✗ Rejected | **✓ Adopted** | ✗ Rejected |

**Decision rationale:** Design B (tower type) is adopted because it is the only form-factor that accommodates all six rated outlet channels while maintaining a small desk footprint, physical stability, and internal separation between the low-voltage controller bay and the AC distribution bus — all within the laboratory's no-interior-damage constraint.

#### A.2 Economic Constraints

| Factor | Detail |
|---|---|
| Target budget | Approximately ₱3,000–₱5,000 (student-funded) |
| Key cost driver | ESP32-S3 (~₱450), PZEM-004T (~₱250), 6× ZMCT103C (~₱180 total), ADS1115 (~₱120), 8-ch relay module (~₱200), 110V step-down module (~₱150), 5V buck + USB (~₱80), enclosure + wiring (~₱300), fuse/MOV/breaker (~₱100) |
| Trade-off: ADS1115 | Added cost (~₱120) to resolve ESP32 ADC noise that causes ±2–5% measurement error in raw ZMCT103C readings; without it, sensor accuracy may fail the multimeter-comparison threshold. The component is cost-justified by the accuracy improvement. |
| Trade-off: ZMCT103C vs ACS712 | ZMCT103C chosen (lower noise, higher precision) over ACS712 (cheaper but noisier with ESP32 ADC); cost difference is minimal and accuracy gain is significant. |

#### A.3 Legal and Safety Constraints

| Constraint | How addressed |
|---|---|
| Philippine Electrical Code (PEC) — low-voltage receptacle equipment | All components rated ≥ 250 V AC / 10 A; 10 A glass fuse at input; MOV surge protection; proper grounding via earth busbar continuously bonded to outlet earth terminals |
| Laboratory no-interior-damage policy | Plug-in, surface-standing configuration; no drilling, no adhesives, no permanent modification to walls, partitions, or furniture; removable without trace |
| Grounding and earth safety | Earth busbar continuous to all outlet earth terminals; **earth is never relay-switched** (always bonded); flame-retardant enclosure; grounded cord with strain relief |
| 110 V auxiliary output safety | Separate fuse; clearly labeled; excluded from load-shed logic; not connected to any controlled relay channel |
| Enclosure safety | Low-voltage (ESP32/sensors) and high-voltage (AC bus/relays) sections physically separated within the enclosure to prevent cross-contamination |

#### A.4 Technical / Performance Constraints

| Constraint | Target |
|---|---|
| Sensor accuracy | Percentage error vs calibrated multimeter within acceptable threshold; mean percentage error reported |
| System response time | Mean response time measured for overload detection, relay switching, selective load response, dashboard control latency, and framework-rule execution |
| System stability | ≥ 85% of total tests must pass under specified conditions |
| Network dependency | Full functionality (remote control, live dashboard, reconfiguration) requires stable WiFi; degraded mode under offline conditions |
| Load limit | Per-channel ≤ 10 A / ≈ 2,200 W; system total ≤ 2,500 W; exceeds this trips fuse or triggers FR-05/06 shedding |
