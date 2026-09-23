# MOR — Chapter 1 Revisions Only (Paste-Ready)

> **What this file contains:** the revisions that belong in **Chapter 1** only.
> - Revision 1 → replaces the existing **Scope and Limitations** section
> - Revision 2 → **NEW subsection** placed right after Scope and Limitations
> - Revision 3 → replaces the existing **Definition of Terms** section
>
> (The Ch.3 items — Central Tendency, Block Diagram, SDLC, Flowchart, Figures, Constraints Appendix — are NOT in this file. Ask me for a Ch.3 pack if you need it.)
>
> **Terminology (agreed):** policy/enforcement replaced with the Framework framing.
> Replace **[bracketed bold]** with your actual lab data.

---

## REVISION 1: Scope and Limitations (REPLACE the existing section in Ch.1)

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

## REVISION 2: System Constraints and Non-Functionalities (NEW subsection — place AFTER Scope and Limitations)

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

## REVISION 3: Definition of Terms (REPLACE the existing section in Ch.1)

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

## Checklist — where each Ch.1 revision fits

| Revision | Location in Chapter 1 | Purpose |
|---|---|---|
| Revision 1 — Scope & Limitations | Replaces the existing Scope and Limitations | Design consideration, lab survey, 110V socket, USB 5V, no-damage policy |
| Revision 2 — System Constraints | New subsection after Scope and Limitations | The 7 "what the device cannot do" items |
| Revision 3 — Definition of Terms | Replaces existing Definition of Terms | Operational definitions with framework framing + RFC 3060-based terms |
