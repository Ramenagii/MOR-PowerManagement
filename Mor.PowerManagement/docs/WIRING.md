# WIRING.md — MOR Power-Management Expansion Board

Physical connection guide for the 13-channel ESP32-S3 relay expansion board,
from wiring through to the GUI dashboard.

**Sources of truth** (every pin and macro below is quoted from these; nothing is
invented):

| File | Role |
|---|---|
| `Mor.PowerManagement/firmware/mor-power-device/config.h` | Pin arrays, Wi-Fi/backend/meter constants |
| `Mor.PowerManagement/firmware/mor-power-device/mor-power-device.ino` | Behaviour of those pins, sampling loop, HTTP calls |
| `Mor.PowerManagement/src/Web/Endpoints/Device.cs` | Server routes the firmware talks to |
| `Mor.PowerManagement/src/Web/ClientApp/src/App.tsx` | How the dashboard receives updates |

Target board: **ESP32-S3** (WCH CH343 USB-serial). Compile with
`--fqbn esp32:esp32:esp32s3`; plain `esp32:esp32:esp32` compiles but refuses to
flash ("This chip is ESP32-S3").

---

## 1. ⚠️ SAFETY WARNING — READ BEFORE MAKING ANY CONNECTION

> ### 8 of the 13 channels switch 220 V mains.
>
> This is not a low-voltage board. Eight of thirteen relay channels
> (CH1-CH8) make and break a 220 V AC feed. Wiring it wrong does not damage the
> prototype - it starts a fire or kills someone. Treat every step involving
> CH1-CH9 as live mains work.

**Before you touch a single wire:**

1. **Work on a fully de-energised, decommissioned circuit.** Open the upstream
   breaker, lock it off, and verify dead with a proven tester *before* touching
   conductors. A relay board plugged into a live feed is not a bench project, it
   is a live installation.
2. **Use a properly rated relay module.** The contacts must be rated for the
   load and the inrush of the attached appliances (relay modules are commonly
   rated 10 A but real loads switch far less usefully). Confirm the relay
   board's **isolation** between coil side and contact side and its
   **coil-current rating** (see §7) *before* applying power. An opto-isolated
   module is the minimum for mains switching; do not assume isolation because a
   board is in an opaque case.
3. **Never bridge the ESP32 GND to mains earth.** Not as a "reference", not as
   a "common", not for any reason. Doing so defeats the isolation the relay
   module provides and puts the entire low-voltage logic - and the USB cable
   back to your laptop - at mains potential. If your design appears to need it,
   the design is wrong.
4. **Mains switching and the 5 V USB rails must not be tied to the 3.3 V
   rail** (see §7). Keep the power domains separate and share only the relay
   coil-side ground as described.
5. **Confirm coil-current rating before energising.** Driving 13 coils from
   ESP32 GPIO directly will exceed the pin's drive current and, in the worst
   case, damage the SoC. Use a driver stage (§7).
6. **Work with the upstream breaker in reach, every time.** First
   energisation of a mains board should have someone else watching the
   breaker.
7. **⚠️ The bench mains supply must be fused and RCD/GFCI-protected.** This is a
   bring-up requirement for this rig, not a "real deployment" detail — a 13-
   channel bench board is a multi-outlet load. Do not energise it from an
   unfused extension lead or a circuit with no RCD/GFCI. This is the
   "protective device rating" referred to in §9 Stage D4.
8. **⚠️ Disconnect USB and power down the ESP32 before touching any mains
   conductor.** Unplug the USB cable and switch off the logic supply *before*
   handling live conductors, not merely before plugging the board in. This is
   stronger than item 3 alone: item 3 notes the USB cable could sit at mains
   potential, but the required precaution is to have it physically absent while
   the conductors are handled.

This prototype is a bench/lab rig. Real deployment requires an appropriately
rated enclosure, fusing, earthing, and compliance with local electrical
regulations - none of which are the subject of this document.

---

## 2. Pin assignment — the full map

### 2.1 Relay outputs

`RELAY_PINS[OUTLET_COUNT]` from `config.h:123`, with `OUTLET_COUNT` = 13
(`config.h:14`):

```cpp
static const uint8_t RELAY_PINS[OUTLET_COUNT] = { 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18 };
```

Channel order confirmed against `config.h:121` ("8x220V (CH1-8), 1x110V via
step-down (CH9), 4xUSB 5V (CH10-13)") and against `ratedVolts[]`
(`mor-power-device.ino:116`): `{220 x8, 110, 5, 5, 5, 5}`.

| CH | Physical function | Rated V | GPIO | Allowance W | Wire that goes there |
|---|---|---|---|---|---|
| 1 | 220 V mains outlet | 220 V | **4** | 500 | Relay board IN1 -> GPIO4 |
| 2 | 220 V mains outlet | 220 V | **5** | 500 | Relay board IN2 -> GPIO5 |
| 3 | 220 V mains outlet | 220 V | **6** | 500 | Relay board IN3 -> GPIO6 |
| 4 | 220 V mains outlet | 220 V | **7** | 500 | Relay board IN4 -> GPIO7 |
| 5 | 220 V mains outlet | 220 V | **8** | 500 | Relay board IN5 -> GPIO8 |
| 6 | 220 V mains outlet | 220 V | **9** | 500 | Relay board IN6 -> GPIO9 |
| 7 | 220 V mains outlet | 220 V | **10** | 500 | Relay board IN7 -> GPIO10 |
| 8 | 220 V mains outlet | 220 V | **11** | 500 | Relay board IN8 -> GPIO11 |
| 9 | 110 V outlet, fed by step-down transformer | 110 V | **12** | 300 | Relay board IN9 -> GPIO12 |
| 10 | USB-A 5 V port | 5 V | **13** | 10 | Relay board IN10 -> GPIO13 |
| 11 | USB-A 5 V port | 5 V | **14** | 10 | Relay board IN11 -> GPIO14 |
| 12 | USB-A 5 V port | 5 V | **15** | 10 | Relay board IN12 -> GPIO15 |
| 13 | USB-A 5 V port | 5 V | **18** | 10 | Relay board IN13 -> GPIO18 |

Rated volts and allowances are the compiled defaults from
`mor-power-device.ino:112,116`; both are **overwritten from the backend** on
`GET /api/Device/config` and stored in NVS. What you wire is what the ESP32
drives, regardless of what those numbers say.

**Note the ADC1 overlap.** CH1-CH8 occupy **GPIO4-GPIO11**, of which
**GPIO4-GPIO10 are also ADC1 channels** (GPIO11 is not). So 7 of ADC1's 10
channels are consumed by relays. See §4.

---
### 2.2 `RELAY_CLOSED_LEVEL HIGH` - what it means for wiring

`config.h:124`: `#define RELAY_CLOSED_LEVEL HIGH`

This is an **active-high relay board**: driving the GPIO HIGH energises the
relay coil, which pulls the contact to its **closed** position, energising the
channel's load. The firmware writes `!RELAY_CLOSED_LEVEL` at boot
(`mor-power-device.ino:666`) to force every channel **open** - a fail-safe: if
the ESP32 dies or the GPIO floats, the mains is disconnected.

| Property | Value | Wiring impact |
|---|---|---|
| Logic sense | Active HIGH | GPIO HIGH = channel energised. Opposite of an active-low "low-trigger" module. |
| Fail state on reset/dead pin | LOW = open | Correct - a dead pin leaves the load off. Do **not** add pull-ups on these pins; that would defeat the fail-safe. |
| Module type required | High-level trigger | A low-level ("low-trigger") module inverts the mapping: the firmware would energise every channel at boot and leave all channels live at reset. |
| `applyRelays()` gate | `!sFault && desiredEnergized[i] && !localShed` (`.ino:216`) | A fault state opens **all** relays regardless of per-channel command. |

### 2.3 If you add a driver stage (e.g. a ULN2803)

**`RELAY_CLOSED_LEVEL` must remain `HIGH`. Do not change it.**

A ULN2803 is a **sinking** Darlington array, and it is **non-inverting with
respect to the coil**:

```
GPIO HIGH  ->  Darlington output transistor turns ON  ->  current sinks
            ->  coil is driven from +5 V down to 0 V  ->  COIL ENERGISED
            ->  contact CLOSED
GPIO LOW   ->  Darlington OFF (output high-Z)         ->  coil de-energised
            ->  contact OPEN
```

So the polarity chain is a **direct match** to the existing constant: GPIO HIGH
means coil energised means contact closed, exactly as `RELAY_CLOSED_LEVEL HIGH`
assumes. No sign change is needed anywhere.

⚠ **Do not "correct" `RELAY_CLOSED_LEVEL` to `LOW` on the grounds that the
ULN2803 is described as a driver stage.** That would be actively dangerous:
`setup()` writes `!RELAY_CLOSED_LEVEL` to every relay pin at boot
(`.ino:666`), so flipping the constant writes **HIGH** at boot, energising all
13 coils with **every outlet live** before the firmware does anything else.
Leave the constant at `HIGH` (§7.2).

Full driver-stage guidance - coil supply sizing, common-ground rules and the
fail-state check - is in §7.2.

### 2.4 Manual switch inputs - NOT WIRED on this prototype

`config.h:132-134`:

```cpp
static const uint8_t SWITCH_PINS[OUTLET_COUNT] = {
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
};
```

**All 13 entries are `0`, and the firmware treats `0` as "not wired"**
(`.ino:667`: `if (SWITCH_PINS[i] != 0) pinMode(..., INPUT_PULLUP);`, and
`handleManualSwitch()` returns immediately when `pin == 0`). Therefore:

- **No manual rocker switches are fitted or connected.** All 13 channels are
  explicitly documented as unwired. There is nothing to wire - do not wire them
  expecting them to work.
- Because the pin is 0, `pinMode()` is never called on it, so the input is not
  even pulled up. Each unwired channel is **inert** rather than reading a
  floating pin.
- **GPIO0 must never be used for a switch input** even if the array is filled in
  naively: it is a strapping pin, and an `INPUT_PULLUP` would drive it HIGH at
  boot (§3).
- Consequence: **POL-02 (pre-activation assessment), POL-03 (deny over-limit
  activation) and POL-04 (post-activation verification) cannot be exercised
  manually.** ⚠ These are **server-side** policies (`Device.cs`,
  `docs/SCHEMA.md`). The config sync carries only the resulting **desired
  status** per outlet; the device never re-derives the decision. So activating from
  the dashboard reaches the device as a desired-status bit, and the local
  `handleManualSwitch()` copy of POL-02/03/04 (`.ino:421-452`) is unreachable
  while `SWITCH_PINS` is all zeros.
- To add switches: change `SWITCH_PINS` in `config.h`, using only non-strapping,
  non-USB, non-flash GPIOs (§3). Wiring alone does nothing. Note there are no
  free ADC1 pins left to trade (§4), so any added switch must also avoid
  GPIO1/GPIO2 if a meter is to be fitted.

> **Historical note (resolved).** This array previously read
> `{ 0, 0, 0, 0, 0, 0 }` - six initialisers for 13 channels. The remaining
> seven elements were implicitly zero-initialised, so behaviour was identical,
> but the intent was ambiguous. It is now a full-width 13-entry literal. The
> mismatches that remain live are listed at the end of this document.

## 3. Reserved / do-not-use GPIO list

Derived from the comments at `config.h:122` ("Safe ESP32-S3 GPIOs avoiding
strapping (0,3,45,46), USB (19,20) and SPI flash") and `config.h:85`.

| GPIO(s) | Category | Why it must stay free |
|---|---|---|
| **0** | Strapping (boot mode) | Sampled at reset to select boot mode. Also the `SWITCH_PINS` sentinel for "unwired" (§2.3). |
| **3** | Strapping (boot mode) | Sampled at reset. It is ADC1-capable but unusable for analog *because* it is strapping - this is a genuine exclusion, not a reservation. |
| **19, 20** | USB D-/D+ | Native USB. Attaching a relay load or ADC front end here interferes with USB-COM and can prevent enumeration. |
| **45, 46** | Strapping (VDET/VPP boot config) | Sampled at reset; external drive can change the boot configuration, including supply-voltage selection. |
| **26-32** | SPI flash (SPICS0, SPIQ, SPID, SPIHD, SPICLK, .) | Dedicated to the on-module flash. Driving these corrupts boot or bricks the module. |

**Why strapping pins specifically must be avoided for analog and relay use.**
A strapping pin is not an ordinary GPIO. The ESP32-S3 samples its level during
the reset window and latches it to decide how to boot (ROM download mode vs.
normal flash boot; VDD/VPP configuration on 45/46). Using one as a signal pin
means the *signal itself* participates in boot selection:

- A **floating or weakly-driven strapping pin** at reset makes the boot-mode
  decision indeterminate. If an ADC front end, a burden-resistor divider, or a
  relay coil pulls it the wrong way, the chip can drop into ROM download mode
  and never run your firmware - presenting as "the board randomly won't flash",
  or "it only boots when the relay is unplugged". The fault is intermittent and
  load-dependent, which is the worst possible way to debug it.
- The same latch governs VDET selection on GPIO45/46, so a load there can also
  select the wrong supply voltage.
- `pinMode()` and `digitalWrite()` only take effect *after* the latch is
  sampled. The firmware **cannot** correct a bad strapping level, because by
  the time your code runs the boot decision has already been made.

For an analog input the problem is worse than marginal, because a bias divider or
burden network *is* a deliberate DC pull. Choosing your bias network silently
chooses a boot-critical level. Avoid these pins entirely.
## 4. ADC pin budget — the binding constraint

This is the section that decides what can actually be measured. The pin choice
is forced by the ADC, not by preference; `config.h:82-89` says so explicitly.

### 4.1 The facts

| Fact | Consequence |
|---|---|
| ESP32-S3 **ADC1 = GPIO1..GPIO10** | 10 channels, usable at any time |
| ESP32-S3 **ADC2 = GPIO11..GPIO20**, unusable **while Wi-Fi is active** | This device is *always* on Wi-Fi - the telemetry POST is its whole purpose (`.ino:675-676`, `config.h:83-84`). **Treat ADC2 as non-existent.** |
| `RELAY_PINS` occupies **GPIO4,5,6,7,8,9,10,11,12,13,14,15,18** | Of ADC1's 10 channels, **7 are already consumed by relays** (GPIO4-GPIO10). |

### 4.2 The arithmetic

```
ADC1 channels ............. GPIO1 .. GPIO10          (10 pins)
  less relay pins ......... GPIO4..GPIO10          ( 7 pins)
  ------------------------------------------------------------
  remaining ............... GPIO1, GPIO2, GPIO3     ( 3 pins)
  less strapping pins ..... GPIO3 (boot-mode strap) ( 1 pin )
  ------------------------------------------------------------
  USABLE FOR ANALOG ....... GPIO1, GPIO2           ( 2 pins)
```

**Only GPIO1 and GPIO2 are usable for analog measurement.** These are exactly
`ZMPT_VOLT_PIN` (1) and `ZMPT_CURR_PIN` (2) in `config.h:90-91`.

### 4.3 Consequence for the meter hardware

**A single ZMCT103C current transformer needs exactly ONE ADC pin.** A CT has one
secondary output; it measures current only. So one of the two free pins is all
that is required, and the other can stay spare.

**Which pin to use - use GPIO2 for the CT, leave GPIO1 spare.** Rationale:

| Choice | For | Against |
|---|---|---|
| **GPIO2** (recommended) | Matches the existing `ZMPT_CURR_PIN` assignment, so the current-measurement role keeps its documented pin. GPIO1 is then simply **spare**. | None material. |
| GPIO1 | Equally electrically valid; `ADC1_CHANNEL_0`. | Takes the pin documented as the *voltage* role, muddying the pairing. |

Both are ADC1 and both are non-strapping, so either is electrically sound. If
you do fit a ZMCT103C, wire it to **GPIO2** and **record in the lab notebook
that GPIO1 is intentionally unused**.

⚠️ **GPIO1 is spare, not "held in reserve for a voltage reference."** A
CT-only build has **no voltage measurement capability at all** (§5.1), so there
is nothing for GPIO1 to measure. It would only become useful with a genuine
voltage-sensing front end.

⚠️ **The code path is still blocked.** The firmware as written does **not** read
a CT on GPIO2: `METER_ZMPT101B` assumes a voltage+current **pair** and will trip
`sFault` on the silent voltage channel, opening all 13 relays. See **§5.5** and
mismatch **M1** before wiring this pin.

**Adding more CTs is not possible on this pin map.** The thesis plan calls for
multiple ZMCT103C units (one per branch); that is infeasible with GPIO1/GPIO2
alone and requires an external multi-channel ADC (e.g. an ADS1115 over I2C) or
moving relays off ADC1 pins. Both are design changes, not wiring changes.

## 5. Meter — ZMCT103C current transformer (honest description)

### 5.1 What the sensor actually is

The real sensor on this build is a **ZMCT103C current transformer**. It is
**not** a ZMPT101B, despite what the firmware names suggest (§5.5).

| Property | Value |
|---|---|
| Type | **Current transformer only.** It cannot measure voltage. There is no voltage output to read. |
| Ratio | Typically **1000:1** - ⚠ **verify against your exact part's datasheet.** ZMCT103B and ZMCT103C variants exist with different ratios. Read the ratio off your part and use that number. |
| Output | **Bipolar AC** current on the secondary winding. No DC component; cannot be read against ground directly. |
| Isolation | Galvanic isolation between primary (mains) and secondary - this is why it is safe to use at all. |
| Board | A bare ZMCT103C is a two-terminal, two-winding transformer. It is **not** a breakout module with an op-amp buffer. You must build the signal chain yourself (§5.2). |

### 5.2 Required signal chain

```
 mains conductor (through CT primary)
        |
        v
   +-----------+
   |  ZMCT103C |   secondary: bipolar AC current, no DC offset
   +-----+-----+
         |
         v
   [burden resistor]     e.g. 100 ohm  <- REQUIRED. Converts secondary
         |                current to a voltage. Without it the secondary
         v                is a near-short and you get no usable signal.
   AC waveform (centred on 0 V, AC only)
         |
         v
   [AC coupling capacitor]  series cap, e.g. 100 nF-1 uF. Blocks DC so the
         |                   next stage sees AC only. Without it the ADC input
         v                   is driven negative on the negative half-cycle.
   AC waveform, ~0 V mean
         |
         v
   [1.65 V bias divider]     two equal resistors (e.g. 10k / 10k) from 3.3 V
         |                    to GND, divider node as the signal reference.
         v                    Centres the waveform inside the ADC input range.
   AC waveform riding on 1.65 V DC
         |
         v
   [op-amp buffer]          rail-to-rail, e.g. an MCP6001/MCP6002. REQUIRED:
         |                   the 10k/10k divider presents ~165 ohm of source
         v                   impedance into the SAR sample-and-hold, which does
   low-impedance signal      not settle within the sampling window.
   ESP32-S3 ADC1 pin  (GPIO2 recommended, see 4.3), ADC_11db attenuation
```

**The 1.65 V bias is mandatory, not optional.** The ADC input range is 0-3.3 V.
A centred AC sine that swings negative would be clipped at zero by the input
protection diodes, distorting the waveform and yielding an asymmetric, incorrect
RMS. Biasing to mid-supply centres the excursion so both half-cycles sit inside
the range.

| Parameter | Value |
|---|---|
| Burden resistor | e.g. **100 ohm** - ⚠ confirm the value actually fitted; it sets the volts-per-amp scale and must match your calibration constant. |
| Coupling capacitor | series, blocks DC |
| Bias divider | 3.3 V -> two equal resistors -> 1.65 V |
| ADC attenuation | `ADC_11db` = **11 dB**, set in `.ino:678-679`; effective measurable range approx **0–3.1 V**, not 3.3 V |
| ADC resolution | 12-bit (`analogReadResolution(12)`, `.ino:677`) |
| Op-amp buffer | **Required** — rail-to-rail (e.g. MCP6001/6002), 3.3 V |

⚠️ **Effective ADC range is not 0–3.3 V.** At `ADC_11db` (11 dB) attenuation the
ESP32-S3 measures roughly **0–3.1 V**, not the full 0–3.3 V. Sizing the bias
network for a 3.3 V full scale assumes headroom that does not exist above about
1.65 V, and will clip the positive-going excursion asymmetrically — the same
distortion as bottom-rail clipping.

⚠️ **Note on the bias value.** The firmware comments say "~1.5 V"
(`config.h:77`, `.ino:53`). **1.65 V is the correct figure** — exactly mid-supply
for a 3.3 V rail — and is what this document specifies. The ~1.5 V in the
comments is superseded.

**Never read the raw signal against ground.** A grounded read sees the 1.65 V DC
bias as a large constant and either saturates or reports nonsense.

### 5.3 How RMS must be derived

RMS comes from the **peak-to-peak excursion about the 1.65 V bias**, never from
the absolute ADC count. The firmware does this correctly in `zmptRms()`
(`.ino:64-85`): sample a window, track min and max counts, take
`peakToPeak = hi - lo`, halve it for peak amplitude, multiply by 1/sqrt(2).

```
Vrms = (peakToPeak / 2) * (3.3 / 4095) * 0.7071 * calibration
```

Because it is a *difference*, the DC bias cancels by construction - that is the
entire reason the excursion method is used instead of an absolute reading.

| Constant | Value | Purpose |
|---|---|---|
| `ZMPT_SAMPLE_COUNT` | 1000 (`config.h:95`) | Samples per window; ~1 kHz over several mains cycles |
| `ZMPT_NOISE_FLOOR` | 12 counts (`config.h:106`) | Excursion below this = "no signal", not "0 A" |
| `ZMPT_VOLT_CAL` / `ZMPT_CURR_CAL` | `1.0f` (`config.h:100-101`) | ⚠ **Uncalibrated.** Indicative only until tuned against a multimeter and a known load. |

The noise floor matters diagnostically: an excursion below 12 counts with 0 A is
a **wiring problem**, not a quiet channel. Reporting it as a genuine 0.0 A reading
would be indistinguishable from real zero load.

---
### 5.4 Interim power is ESTIMATED, not measured

This must not be overstated anywhere in the UI. With a CT:

| Quantity | How it is obtained | Status |
|---|---|---|
| **I_rms** | Measured by the ZMCT103C on the common feed | **Measured** (subject to calibration) |
| **V** | **Not measured.** No voltage sensor is fitted on a CT-only build. | **Nominal / assumed** |
| **P** | `nominal rail voltage x I_rms x assumed power factor` | **ESTIMATED** |
| **Per-channel P** | Total x that channel's allowance share of the allowance sum | **ESTIMATED allocation**, not a per-channel measurement |

Two hard consequences:

1. **Without a power factor, `P` is apparent power (VA), not real power (W).**
   Any figure presented as watts is assuming a power factor. Either state the
   assumed PF alongside it, or do not call it watts.
2. **The UI must not label per-channel values as individually measured V/A/W.**
   The firmware distributes one metered total across channels by allowance
   weighting (`.ino:306-324`). A single CT cannot distinguish which branch is
   drawing. Per-channel numbers are an allocation model and the dashboard must
   present them as such.

There is exactly one meter on the common feed, so total current is meaningful;
per-channel figures are not measurements.

### 5.5 Known mismatch: `METER_ZMPT101B` is wrong for a ZMCT103C

**The existing meter code path must not be used as-is with a ZMCT103C.**

| | What the code assumes | What the hardware is |
|---|---|---|
| Sensor | `METER_ZMPT101B` (`config.h:55,64,90-91`) | **ZMCT103C** current transformer |
| Channels | A **voltage + current PAIR** on two ADC pins | **One current output only** |
| Pins | `ZMPT_VOLT_PIN 1` **and** `ZMPT_CURR_PIN 2` - both required | One pin is enough; one of the two does not exist on the hardware |
| Front end | ZMPT101B **breakout module** with integrated burden resistor and LM358 buffer (`config.h:76-77`) | A **bare CT**: you must add the burden, coupling cap and bias yourself (§5.2) |

Why the existing path is actively wrong, not merely misnamed:

- `readMeters()` calls `zmptRms()` on **both** pins then computes
  `p = vRms * aRms` (`.ino:262-278`). With a CT, the "voltage" pin carries no
  voltage signal - it floats or sits at the bias - so the product is meaningless.
- Worse, `!vOk` (a silent voltage channel) is treated as a **sensor fault**
  (`.ino:267-274`), tripping `sFault` after `FAULT_TRIP_COUNT` = 3 consecutive
  failures and **opening all 13 relays**. With a CT-only build the voltage
  channel is silent *by design*, so the board would declare a fault and shut the
  entire rig down.

**Until this is reconciled, keep `METER_SOURCE` at its current default of
`METER_SIMULATE`.** `config.h:67-69` sets that default, and it is the safe
setting: no sensor is required and the telemetry -> dashboard path is fully
testable. Switching to `METER_ZMPT101B` with a ZMCT103C fitted will fault the rig
as described.

Reconciling it is a **code change, out of scope for this wiring guide**: drop the
voltage-channel assumption, read a single ADC pin for current, and remove the
voltage-silent -> fault rule. This document does not edit the firmware.

---

## 6. PZEM-004T alternative — the path to real V/A/W

A PZEM-004T v3.0 measures **voltage, current and power directly**, which removes
both the assumed-PF problem (§5.4) and the voltage-channel mismatch (§5.5). It
is the intended upgrade once a real meter is installed.

> ### ⚠ BLOCKER-LEVEL HAZARD: a PZEM-004T is NOT isolated from mains
>
> **A PZEM-004T v3.0 places the ESP32 at mains potential.** Do **not** connect its
> GND to the ESP32's GND.
>
> The PZEM's optocoupler isolates **only the CT secondary from the logic
> side**. Its **voltage measurement is non-isolated**: the module's GND is
> referenced to the mains side, and the voltage-sense network is bonded to it.
> Tying module GND to ESP32 GND therefore **bridges mains potential into the
> ESP32**, its USB cable, and your laptop - precisely the act §1 item 3 forbids.
> Note this is exactly the opposite of the ZMCT103C, which *is* galvanically
> isolated (§5.1).
>
> **Consequences:**
> - A PZEM-004T v3.0 **cannot be used with a direct UART connection to this
>   ESP32.** Doing so is unsafe regardless of how the terminals are arranged.
> - To use a PZEM you need **both** a genuinely isolated meter variant **and** an
>   isolated serial interface - e.g. an isolated UART/optocoupler pair, or a
>   galvanically isolated RS-485/Modbus adapter - with no galvanic path between
>   the two sides.
> - Until that hardware exists, **the PZEM option is not buildable.** Leave
>   `METER_SOURCE` at `METER_SIMULATE`; §5's ZMCT103C path is the only one that
>   can be safely wired today, and it is itself blocked by M1 (§5.5).

### 6.1 Pin and bus parameters

| Parameter | Value | Source |
|---|---|---|
| RX pin | **GPIO16** | `PZEM_RX_PIN` (`config.h:111`) |
| TX pin | **GPIO17** | `PZEM_TX_PIN` (`config.h:112`) |
| UART | `Serial2` | `mor-power-device.ino:37` |
| Modbus address | **1** (`0x01`) | `.ino:37` |
| Placement | **Single meter on the common mains feed** | `config.h:108-110` |

### 6.2 Signal-side wiring (logical side - the isolated half)

The optocoupler-isolated half of the module:

| PZEM-004T terminal | Connect to |
|---|---|
| RX (module receives) | Isolated-UART TX → ESP32-S3 **GPIO17** (TX) |
| TX (module transmits) | Isolated-UART RX → ESP32-S3 **GPIO16** (RX) |
| 5V (isolated supply) | Supply powering **only the isolated logic side** of the interface |
| GND (isolated logic side) | **ESP32 GND - and only this terminal** |

⚠ **TX/RX cross.** The library is constructed as
`PZEM004Tv30 mainsMeter(Serial2, PZEM_RX_PIN, PZEM_TX_PIN, 0x01)`, so the first
pin is the ESP32's **RX** and must meet the module's **TX**. The two are adjacent
GPIOs and easy to swap; a swapped pair simply never responds, with no error.

⚠ The isolation components above are **not standard on a PZEM-004T v3.0** -
they are the additional hardware this module requires. Do not assume the
"isolated UART" column can be wired directly to the module's own 5V/GND pins.

### 6.3 Mains-side terminals (the non-isolated half)

⚠ These are the terminals that create the hazard above. They are the reason
the whole section is blocked. Documented for completeness so the wiring is
unambiguous **if** isolated hardware is used.

| PZEM-004T terminal | Connection |
|---|---|
| **Voltage input L** | Mains **line**, upstream of the common feed |
| **Voltage input N** | Mains **neutral** |
| **Current-transformer terminals** (the CT winding pair) | The single **current** conductor of the common mains feed - the line conductor passes through the CT; the neutral does **not** |
| Module GND / voltage-sense reference | Bonded to the **mains side**. ⚠ **Never** to ESP32 GND. |

⚠ **This voltage-sense bond is precisely the isolation gap.** It is why §6.1's
isolated interface is mandatory rather than optional, and why no arrangement of
these terminals can make a stock PZEM-004T v3.0 safe to attach to an ESP32.

Enable it by changing one constant in `config.h` - no other code change is
needed (`config.h:60-62`):

```cpp
#define METER_SOURCE METER_PZEM004T
```

**Note:** with a CT fitted *and* a PZEM added, only one of the two can be the
active `METER_SOURCE` at a time - they are mutually exclusive compile-time
selections, not simultaneous inputs.

---

## 7. Power supply — three separate domains

**The ESP32-S3 is a 3.3 V device.** Its I/O is not 5 V tolerant. Mixing domains
is the most likely way to destroy the board.

| Domain | Voltage | Source | Loads |
|---|---|---|---|
| Logic | **3.3 V only** | USB or a 3.3 V regulator | ESP32-S3; CT signal chain (burden, coupling cap, 1.65 V bias divider, op-amp buffer — §5.2) |
| Relay coils | per coil rating | **separate supply** (§7.2) | 13 relay coils |
| USB ports | **5 V** | **its own 5 V supply** (§7.3) | CH10-CH13 |

### 7.1 Rules

- **Never tie the mains switching or the 5 V USB rails to the 3.3 V rail.**
  Back-feeding 5 V into a 3.3 V rail destroys the regulator and the SoC.
- **CH10-CH13 (USB 5 V) need their own 5 V supply.** The ESP32's 3.3 V rail
  cannot power USB ports, and USB ports are not a source of power. Use a
  regulated 5 V supply for the buck rail feeding the USB sockets, switched by
  relays CH10-CH13.
- **The 5 V rail and the mains must remain galvanically separate.** The USB
  socket's 5 V must not be derived from the mains without an isolated
  converter. A non-isolated buck converter on the mains side puts the USB
  socket and anything plugged into it at mains potential.
- **CH9 (110 V) must be fed by a galvanically isolated step-down
  transformer** from the mains feed, upstream of relay IN9. ⚠ **An
  *autotransformer* is not acceptable here.** For 220 V → 110 V an autotransformer
  is the cheap and obvious choice, and it leaves the 110 V socket at mains
  potential with no isolation barrier - exactly the failure this document spends
  §1 preventing. Specify a **true isolation transformer** with a separate
  secondary winding. `config.h:121` says only "1x110V via step-down" and does not
  mention isolation; that requirement comes from §1 and is not optional.

### 7.2 Relay coil supply and driver stage

⚠ **Do not drive the relay coils directly from ESP32 GPIO.**

| Concern | Detail |
|---|---|
| GPIO drive current | ESP32-S3 pins source/sink only a few mA (single-pin drive is small; the total budget across all pins is also limited). A typical 5 V relay coil draws **~70-90 mA**. |
| 13 coils together | ~0.9-1.2 A total coil current, plus inductive inrush. Far beyond what the SoC can source. |
| Inductive transients | A coil is an inductor. Unsnubbed, the back-EMF at switch-off stresses the driving device. |
| Result | GPIO overstress, SoC damage, or an unreliable reset under load. |

**Use a driver stage - a ULN2803 or discrete transistor per channel.**

| Recommendation | Detail |
|---|---|
| **ULN2803** (preferred) | 8 channels per IC, so **two ULN2803s** cover 13 channels. Integrated Darlington + freewheeling diodes, so no external snubbers are needed. |
| Drive level | A ULN2803 is a **sinking** Darlington array and is **non-inverting with respect to the coil**: input HIGH turns the output transistor ON, which pulls current through the coil and energises it (GPIO HIGH → Darlington ON → coil energised → contact closed). That is a **direct match** to `RELAY_CLOSED_LEVEL HIGH`; no sign change is needed. ⚠ **Do not flip `RELAY_CLOSED_LEVEL` to `LOW`** - `setup()` writes `!RELAY_CLOSED_LEVEL` at boot, so flipping it drives all 13 coils HIGH and energises every outlet before the firmware runs (§2.3). |
| Coil supply | Sized for **all 13 coils simultaneously closed**, with margin. If each coil is ~90 mA, allow ≥ 1.5 A at the coil rail, and give it real bulk decoupling near the board. |
| Common ground | The driver/relay supply ground must be **common with ESP32 GND on the low-voltage side only.** ⚠ It must **never** be connected to mains earth (§1, item 3). |
| Fail state | Verify that a de-powered or reset ESP32 leaves the coils OFF - i.e. the fail-open behaviour the firmware assumes (§2.2). |

⚠ **Confirm the relay board's coil-current rating and its isolation between
coil side and contact side before applying power** (§1, item 2). An opto-isolated
module is the minimum for mains switching.

---

## 8. End-to-end data flow: physical wiring to GUI

### 8.1 The chain

```
  PHYSICAL                        DEVICE                         NETWORK                     BACKEND                    BROWSER
  -------                        ------                         -------                     -------                    -------

  CT secondary
    -> burden R
    -> AC coup cap
    -> 1.65 V bias
    -> op-amp buffer
       |
       v
  [ GPIO2 ADC1 ]  --(1)-->  readMeters()            --(2)-->  HTTPS POST        --(3)-->  IngestTelemetry
   ESP32-S3 pin               .ino:228                    every 5 s                    Device.cs:23
                             zmptRms() .ino:64          POST /api/Device/telemetry          |
                                                           + X-Device-Key                      | persisted
                                                           + DEVICE_API_KEY                    v to DB
                                                                                       stores rows

  [ Dashboard SPA ] <--(6)-- GET /api/Dashboard/state <------------------------------------+
       ^                     every 5 s, cookie auth, NO SignalR, NO push
       +-- renders V/A/W, relay states, provenance badge

  relay coils  <--(7)--  applyRelays()  .ino:214  <--------  GET /api/Device/config  <--  GetDeviceConfig  <--(4)--
    (13 ch)                 digitalWrite(RELAY_PINS)        every 15 s                  Device.cs:32          policy table from
                           RELAY_CLOSED_LEVEL               config.h:44                          Dashboard edits
  LED_BUILTIN <--(8)--    (t/500)%2 .ino:751
```

> NOTE: hop (1) - the CT -> GPIO2 -> zmptRms() path - is HYPOTHETICAL and must NOT
> be built as drawn. It is shown for completeness of the signal path, but
> METER_ZMPT101B assumes a voltage+current PAIR and will trip sFault on the
> silent voltage channel, opening all 13 relays (S5.5, M1). With the current default
> METER_SOURCE = METER_SIMULATE, hop (1) does not execute at all: readMeters()
> synthesises the values and the CT chain is unused. The LIVE path today is SIM, or
> PZEM once isolation is solved (S6).

Hop numbering: (1) ADC sampling, (2) Wi-Fi HTTPS POST, (3) server ingest,
(4) config sync, (5) server persistence, (6) dashboard poll, (7) relay actuation,
(8) status LED.

### 8.2 Hop-by-hop, with the concrete mechanism

| # | Hop | Mechanism | Source |
|---|---|---|---|
| 1 | **ADC sampling** | `readMeters()` is called **every `loop()` iteration**, at the top of the loop. `loop()` ends with `delay(200)`, so the effective sampling period is **~200 ms in SIM/PZEM mode only**. ⚠️ In `METER_ZMPT101B` mode each `readMeters()` performs 2 x 1000 `analogRead()` calls (`.ino:262-263`), which dominates the loop time by a wide margin, so iterations are substantially slower than 200 ms. 12-bit resolution and `ADC_11db` attenuation are set once in `setup()`. | `.ino:228,262-263,677-679,729,754`; `config.h:95` |
| 2 | **Wi-Fi** | Credentials come from **NVS flash** (namespace `morwifi`), holding up to `WIFI_SLOTS` = 3 saved networks. `config.h` SSID/password are **first-boot seeds only**. Join is tried last-working-first, then each remaining slot, then a scan. `WIFI_JOIN_TIMEOUT_MS` = 12000 per attempt. | `config.h:28-29`; `.ino:143-198,694-720` |
| 3 | **HTTPS POST** | `HTTPClient` over `WiFiClientSecure` (`setInsecure()`). Host `mor-powermanagement.onrender.com`, port `443`, `BACKEND_USE_TLS 1`, base `/api`. URL built by `backendUrl()`. Auth via the `X-Device-Key` header carrying `DEVICE_API_KEY`. Body is ArduinoJson with `deviceId` = `DEVICE_ID` (`mor-prototype-01`), `faultFlag`, `missedPosts`, `meteringMode`, plus `readings[]` and `relayStates[]` arrays of 13 entries. Sent every `TELEMETRY_INTERVAL_MS` = **5000 ms**. | `config.h:33-38,43`; `.ino:200-212,584-636` |
| 4 | **Config sync (reverse direction)** | `GET /api/Device/config` every `CONFIG_INTERVAL_MS` = **15000 ms**, same TLS + `X-Device-Key`. Parses thresholds and the per-outlet policy table (allowance, priority, rated volts, desired status, idle limit) and persists to NVS namespace `mor` with magic `MOR2`, so the ESP32 enforces the last synced policy with no network. | `.ino:525-582`; `config.h:44` |
| 5 | **Server ingest** | `POST /api/Device/telemetry` -> `IngestTelemetry`, which stores per-outlet readings, refreshes live outlet state, and evaluates threshold crossings and fault lockout. Returns `Ok<IngestTelemetryResult>`. `GET /api/Device/config` -> `GetDeviceConfig` returns thresholds + the policy table. Both are `AllowAnonymous()` at group level with an `X-Device-Key` filter. | `Device.cs:12-38` |
| 6 | **Dashboard receive mechanism** | ⚠ **There is NO SignalR, WebSocket, or server push anywhere in this solution.** A search for `SignalR`/`MapHub`/`HubConnection` returns zero hits. The mechanism is **client-side polling**: the SPA runs `window.setInterval(() => refreshFromBackend(), 5000)` while authenticated, so it re-fetches `GET /api/Dashboard/state` (cookie-authenticated, *not* the device key) every 5 s. Failure sets `backendOnline(false)` - the offline badge. | `App.tsx:105-111`; `api.ts:168-169`; `Dashboard.cs:23` |
| 7 | **Relay actuation** | `applyRelays()` computes `closed = !sFault && desiredEnergized[i] && !localShed`, then `digitalWrite(RELAY_PINS[i], closed ? RELAY_CLOSED_LEVEL : !RELAY_CLOSED_LEVEL)`. Called every loop after policy evaluation, and after each config sync. | `.ino:214-220,692,722-732` |
| 8 | **Serial snapshot** | `printChannelSnapshot()` every `SNAPSHOT_INTERVAL_MS` = 5000 ms, driven from `loop()` rather than from `postTelemetry()`, so the bench stays observable with no backend reachable. Prints `C`/`o` per channel plus W and the channel's own volts; in ZMPT mode it also prints `v_pp` / `i_pp`. | `.ino:645-658,745-748` |

### 8.3 Latency — stated plainly

Transport is device **push** to server, then server **poll** to browser. So the
end-to-end delay from a physical change to a painted dashboard is **up to about
10 seconds**: up to 5 s waiting for the device's POST, plus up to 5 s waiting
for the browser's next GET. This is a property of the polling design, not a
defect, but do not describe the dashboard as "live" or "real-time" without
qualifying it.

Also note the device POST and the browser poll are **not synchronised**, so the
UI is up to one full cycle behind the device at all times.

### 8.4 First-contact behaviour: expect `HTTP -11`

Observed on first boot against the Render deployment: telemetry and config sync
both returned **`HTTP -11`** for the first ~30 s, then began returning `200`
without any intervention.

`-11` is Arduino `HTTPClient::connectionFailed()`. The cause here is **Render's
free-tier cold start** — the instance is spun down when idle and takes tens of
seconds to boot, so the first TLS connections from the device time out before
the app is listening. DNS and TCP 443 are both fine throughout.

Nothing is wrong with the device, the certificate, or the API key. The firmware
retries on its own intervals (`TELEMETRY_INTERVAL_MS` 5000, `CONFIG_INTERVAL_MS`
15000) and recovers once the host is awake.

**So: a cold-start `-11` burst on boot is expected and self-clearing.** It is
only a fault if `-11` persists continuously, which points at DNS/Wi-Fi rather
than the host. Note the device joins Wi-Fi before this point, so an `-11` storm
actually *confirms* the radio worked.

---

## 9. Bring-up checklist

Ordered so that every step is verifiable **before** the next risk is
introduced. **Do not skip to step 6.** The whole point is to prove the software
chain with no mains and no meter hardware attached.

### Stage A - Software only. No mains, no sensors.

| # | Step | Expect to see | Pass criterion |
|---|---|---|---|
| A0 | ⚠️ **Set `WIFI_PASS` in `config.h` BEFORE the first flash.** `config.h:25` ships as `#define WIFI_PASS ""` (empty, so no secret is committed), and `config.h:22-23` says "Fill it in locally before the first flash". | — | **Non-empty password, or an open network.** If you flash as-is, `tryJoin()` seeds slot 0 with an SSID and an empty password (`.ino:159-161`), fails against a WPA2 network, and the only symptom is a generic `Wi-Fi failed` with a scan listing — **no hint that the cause is your own empty password.** |
| A1 | Confirm `METER_SOURCE` is `METER_SIMULATE` (`config.h:67-69`) | - | **The safe default.** Do not change it yet (§5.5). |
| A2 | Flash over USB-COM: `arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device` | - | Flash succeeds. Using `--fqbn esp32:esp32:esp32` instead will fail with "This chip is ESP32-S3". |
| A3 | Open the serial monitor at **115200 baud** | `MOR power-management prototype starting` then `SIM mode: synthetic mains readings (no sensor wired)` | SIM mode confirmed - this proves no sensor is expected yet. |
| A4 | Check Wi-Fi join | `Wi-Fi trying "<ssid>" ...`, then `IP: <address>` | ⚠ **If the board already has a saved network in NVS, that one wins and a new SSID in `config.h` is ignored** (the seed only applies when NVS slot 0 is empty, `.ino:159`). Erase NVS/flash to change networks. If it fails, the firmware prints a scan listing every visible SSID - use that. |
| A5 | Watch the serial snapshot | `channels: 1:o0W/220V 2:o0W/220V ...` repeating every 5 s, all `o` (open) | All 13 channels listed, every relay **open** at rest. This is the fail-safe state and must be true with nothing connected. |
| A6 | Activate a channel from the dashboard | `config synced: P_limit=3600 W, 13 channels` and `POL-02`-style state change in the snapshot (`o` becomes `C`) | Config sync works and relay state changes. |

### Stage B - Confirm the device reaches the dashboard.

| # | Step | Expect to see | Pass criterion |
|---|---|---|---|
| B1 | Sign in to the dashboard | - | Session is authenticated (cookie auth, not the device key). |
| B2 | Watch the serial log | `telemetry: HTTP 200, total=<N>W` every 5 s | **HTTP 2xx** from `POST /api/Device/telemetry`. A `401` means `DEVICE_API_KEY` does not match the backend's `Device:ApiKey`. |
| B3 | Confirm the device appears in the dashboard | Device-online indicator lit; `deviceLastSeen` advancing; **Simulated** provenance badge | The device is visible and the badge reads **Simulated**, which is correct in SIM mode. |
| B4 | Change a threshold in the dashboard, wait ~15 s | `config synced: P_limit=... W` on serial | The reverse path (Dashboard → device) works. |

⚠ **Expect up to ~10 s of lag** between a physical change and the dashboard (§8.3). Wait two full cycles before concluding something is broken.

### Stage C - Meter hardware. Still no mains on the outlets.

| # | Step | Expect to see | Pass criterion |
|---|---|---|---|
| C1 | ⚠ **Resolve the §5.5 mismatch FIRST** | - | `METER_ZMPT101B` assumes a V+I pair and will declare a fault with a CT-only build. Do not switch `METER_SOURCE` until the code is reconciled. |
| C2 | Confirm the CT part marking and ratio | - | Verify ZMCT103**C** vs ZMCT103**B**; the ratio differs. Record it. |
| C3 | Confirm the burden resistor actually fitted | - | Record the value (e.g. 100 Ω). It sets the scale for `ZMPT_CURR_CAL`. |
| C4 | Wire the CT chain: secondary → burden → coupling cap → 1.65 V bias divider → op-amp buffer → **GPIO2** | - | Continuity-check the divider reads 1.65 V **before** connecting to the ESP32. |
| C5 | Power up with the CT around a **low-voltage, isolated source** (e.g. a bench supply or a low-watt lamp on an isolated winding) - not the mains feed | Serial `zmpt: v_pp=... i_pp=...` | A **non-zero** `i_pp` that grows with load. `i_pp = 0` means a wiring fault, not an idle channel. |
| C6 | Calibrate against a multimeter | - | Tune `ZMPT_CURR_CAL` (currently `1.0f` = uncalibrated) until the reading matches the reference. Until then the value is **indicative only**. |

### Stage D - Mains. Only now.

| # | Step | Expect to see | Pass criterion |
|---|---|---|---|
| D1 | ⚠️ Re-read §1 in full, and confirm the bench supply is **fused and RCD/GFCI-protected** (§1 items 7) | — | Safety understood; breaker in reach; circuit verified dead; protection in place. |
| D1a | ⚠️ **Confirm the CH9 step-down transformer is a galvanically ISOLATED type, not an autotransformer** (§7.1) | — | Separate secondary winding. An autotransformer leaves the 110 V socket at mains potential — do **not** energise CH9 on one. |
| D2 | Energise **one** channel only, with a single low-wattage load | That channel reads `C`; others `o` | Correct channel and no others. Confirms the pin-to-channel mapping (§2.1). |
| D3 | Verify the mapping is 1:1 | Each channel toggles independently as commanded | **Critically: confirm CH1→GPIO4 ... CH13→GPIO18.** An off-by-one here energises the wrong outlet. |
| D4 | Add loads progressively | Power readings scale | Stops before the protective device rating is approached. |
| D5 | Test the fault path | On a genuine sensor fault: `POL-01: S_fault TRUE ... all relays opened` | **All** relays open. If only the faulted channel opens, the fail-safe is not working - stop. |

### Throughout, on every stage

- Keep the ESP32 on **USB power** where possible, so the logic domain is
  independent of the relay supply.
- Never leave a mains channel energised unattended.
- Do not connect mains earth to the ESP32 ground, ever (§1, item 3).

---

## Known mismatches (code vs. hardware)

Where the source and the real hardware disagree. **These are documented, not
fixed** - this guide does not edit the firmware.

### M1 - `METER_ZMPT101B` is wrong for a ZMCT103C  ⚠ LIVE, blocking

| | |
|---|---|
| **Code says** | `METER_ZMPT101B` - a **voltage + current PAIR** on two ADC pins (`ZMPT_VOLT_PIN 1`, `ZMPT_CURR_PIN 2`), via a breakout module with integrated burden and LM358 buffer (`config.h:55,64,76-77,90-91`) |
| **Hardware is** | A **ZMCT103C** - a **current transformer only**, one AC output, bare component requiring an external burden, coupling cap and 1.65 V bias (§5) |
| **Impact** | `p = vRms * aRms` (`.ino:278`) is meaningless - there is no voltage. Worse, a silent voltage channel trips `sFault` after 3 failures and **opens all 13 relays** (`.ino:267-274`), shutting the rig down. |
| **Mitigation now** | Keep `METER_SOURCE` at its default `METER_SIMULATE` (`config.h:67-69`). This is the safe setting. |
| **Fix** | Code change: single-ADC-pin current read, remove the voltage-silent → fault rule. Out of scope here. |

### M2 - `SWITCH_PINS` - RESOLVED

This array previously had **6 initialisers for 13 channels**
(`{ 0, 0, 0, 0, 0, 0 }`). The remaining 7 elements were implicitly
zero-initialised, so **runtime behaviour was identical** - `0` means unwired and
`handleManualSwitch()` returns early - but the intent was ambiguous. It is now
a full-width 13-entry zero literal (`config.h:132-134`).

The substantive point is unchanged and remains a wiring fact: **no rocker
switches are fitted on this prototype.** POL-02/03/04 are not manually
reachable (§2.3).

### M3 - CT current vs. assumed power factor  ⚠ LIVE, affects all reported watts

| | |
|---|---|
| **Code says** | `powerWatts` is posted per channel and rendered as watts (`api.ts` `MeteringMode` comments) |
| **Hardware is** | A CT measures current only. No voltage sensor, no power factor. |
| **Impact** | P is `nominal V × I_rms × assumed PF`. Without PF that is **apparent power (VA), not real watts**. Per-channel figures are an **allowance-weighted allocation** of one common-feed total (`.ino:306-324`), not per-channel measurements. |
| **Requirement** | The UI **must not** label per-channel values as individually measured V/A/W. A single CT cannot attribute draw to a branch. Install the PZEM-004T (§6) for real V/A/W. |

### M4 - No SignalR / no push transport  ⚠ Informational

The dashboard might be assumed to receive push updates. It does not: there is
**no SignalR, WebSocket, or server-push mechanism anywhere in the solution**
(zero hits for `SignalR`/`MapHub`/`HubConnection`). The browser **polls**
`GET /api/Dashboard/state` every 5 s (`App.tsx:105-111`). Combined with the
device's 5 s POST, end-to-end latency is **up to ~10 s** (§8.3). Any
"real-time"/"live" claim in the UI or the thesis text needs qualifying.

### M5 - Thesis hardware plan vs. this build

The thesis plan describes **six** ZMCT103C units, one per branch, plus an
ADS1115 external ADC. **This build can accommodate at most ONE analog front end**
on GPIO1/GPIO2 (§4). Multiple CTs require an external multi-channel ADC (ADS1115
over I2C) or moving relays off ADC1 - a design change, not a wiring change.

### M6 - Calibration constants are placeholders

`ZMPT_VOLT_CAL` and `ZMPT_CURR_CAL` are both `1.0f` (`config.h:100-101`) - i.e.
**uncalibrated**. Until tuned against a multimeter and a known load, any meter
reading is **indicative only** and must not be presented as a calibrated
measurement.

---

## Open hardware confirmations required

These cannot be determined from the source and must be checked against the
physical hardware before the meter path is trusted:

1. **The exact ZMCT part marking** - ZMCT103**C** vs ZMCT103**B**. The
   transformation ratio differs and directly scales every current reading.
2. **The burden resistor value actually fitted** - the 100 Ω in §5.2 is a
   recommendation, not a confirmed value. It must match the calibration
   constant.

---

## Appendix — quick reference

| Item | Value |
|---|---|
| Board | ESP32-S3, FQBN `esp32:esp32:esp32s3` |
| Channels | 13 - 8× 220 V, 1× 110 V (step-down), 4× USB 5 V |
| Relay GPIOs | 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18 |
| Relay logic | `RELAY_CLOSED_LEVEL HIGH` (active-high, fail-open) |
| Switch inputs | none - all 13 `SWITCH_PINS` are `0` (unwired) |
| Analog pins free | GPIO1, GPIO2 only (ADC1; ADC2 unusable on Wi-Fi) |
| CT pin | GPIO2 recommended |
| PZEM | RX GPIO16, TX GPIO17, Modbus addr 1, `Serial2` |
| Do-not-use | GPIO0, 3, 45, 46 (strapping); 19, 20 (USB); 26-32 (flash) |
| Backend | `mor-powermanagement.onrender.com:443`, HTTPS, base `/api` |
| Device ID | `mor-prototype-01`, auth via `X-Device-Key` |
| Telemetry | every 5 s -> `POST /api/Device/telemetry` |
| Config sync | every 15 s -> `GET /api/Device/config` |
| Dashboard | browser **polls** `GET /api/Dashboard/state` every 5 s; no SignalR |
| End-to-end latency | up to ~10 s |
| Serial | 115200 baud; snapshot every 5 s |

---

*Sources: `firmware/mor-power-device/config.h`, `firmware/mor-power-device/mor-power-device.ino`,
`src/Web/Endpoints/Device.cs`, `src/Web/Endpoints/Dashboard.cs`, `src/Web/ClientApp/src/App.tsx`,
`src/Web/ClientApp/src/api.ts`. All GPIO numbers and macro values quoted directly from these files.*
