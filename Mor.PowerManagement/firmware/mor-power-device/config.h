#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// MOR power-management prototype — ESP32 edge controller.
// Edit the values below for your bench, then compile and flash with:
//   arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
//   arduino-cli upload -p COM12 --fqbn esp32:esp32:esp32s3 firmware/mor-power-device
// The board is an ESP32-S3 (WCH CH343 USB-serial). Using esp32:esp32:esp32
// compiles but esptool refuses the flash with "This chip is ESP32-S3".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LIVE RIG (5 channels): 4x220V CT-metered outlets + 1x USB socket.
// ---------------------------------------------------------------------------
//   outletId 1..4  220 V mains outlets, one ZMCT103C CT each on the ADS1220
//                  (AIN0, AIN1, AIN2, AIN3). Watts are derived from the CT
//                  amps x the ONE mains voltage below, exactly as before.
//   outletId 5     USB socket, MONITORED ONLY. No CT is fitted, and there is no
//                  relay: the socket is never actuated by this firmware. Its
//                  volts/amps/watts come straight off the INA226, which is the
//                  3.3 V rail monitor and nothing else (see the INA226 block
//                  below).
//
// Every outlet on this rig therefore has a real sensor behind it: CH1-4 behind
// a CT, CH5 behind the INA226. Nothing is posted as a fabricated zero or a
// residual.
//
// Tier roles (the backend seed must carry these so the priority logic and the
// dashboard labels agree with the device; RULES_ENABLED is still 0, so the
// firmware does not act on them yet):
//   CH1  Critical     always-on load that must never be shed
//   CH2  Important    shed only under real pressure
//   CH3  Deferrable   shed first when the budget is tight
//   CH4  Nonessential shed early, cheap to lose
//   CH5  USB          Low / priority-only - monitored, never switched
//
// Restore to 13 for the final rig: CH1-8 220V, CH9 110V, CH10-13 USB.
// ---------------------------------------------------------------------------
#define OUTLET_COUNT 5

// ---- Wi-Fi ----
// Credentials live in NVS flash (written on first setup), so the repo never
// holds a real password. The values in config.h are first-boot seeds only and
// are ignored once NVS holds a working network.
//
// config.local.h is where real credentials go, and it is git-ignored so a
// password can never reach the repository by accident. Copy
// config.local.h.example to config.local.h and fill it in.
#if __has_include("config.local.h")
#include "config.local.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif

// Saved-network store: up to WIFI_SLOTS SSID/password pairs in NVS.
#define WIFI_SLOTS 3
#define WIFI_JOIN_TIMEOUT_MS 12000UL

// ---- Backend (ASP.NET Core Web API) ----
// LAN bench: point the device at the PC running the backend. The cloud host
// still runs the full 13-channel rig and re-seeds it on every start, which
// silently overwrites the 2-channel testing configuration that MUST_READ.md
// defines for this phase. Talking to the LAN backend keeps the testing rig and
// the dashboard in the same place.
#define BACKEND_HOST "192.168.18.47"
#define BACKEND_PORT 5211
#define BACKEND_BASE "/api"
// 1 = https (host has a real cert), 0 = plain http for the LAN bench.
#define BACKEND_USE_TLS 0
#define DEVICE_ID "mor-prototype-01"
// Must match the backend Device:ApiKey when key enforcement is turned on.
#define DEVICE_API_KEY "vuZAWog0U6MnqHF58TK3DhCzO9Je2atQ"

// ---- Timing ----
// Telemetry is 1 Hz so the console reads as live rather than as a slow poll.
#define TELEMETRY_INTERVAL_MS 1000UL
// How often the outlet policy table (and its desiredStatus) is re-read.
// WAS 15000 ms, which is why a disconnect felt like "nothing happens": the
// command sat in the backend while the device was two polls away from asking
// for it.
//
// It then had to go FASTER than telemetry, not just "often enough". The backend
// treats the device as the authority on relay state: IngestTelemetry resets an
// outlet to Active/Standby on EVERY batch in which the device reports
// relayClosed = true. A manual Disconnect therefore only survives if the device
// opens the relay before the next telemetry POST - with a 2 s config poll and
// 1 Hz telemetry the backend erased the command first, every time, and the two
// halves locked against each other (backend re-asserts Active, device re-reads
// Active, outlet stays live while the dashboard shows it disconnected).
//
// So: 500 ms config poll, 1 Hz telemetry. The command is picked up and acted on
// within one poll, then confirmed by the following telemetry batch.
// IF THE BACKEND EVER STOPS RE-ASSERTING Active ON relayClosed, this can go back
// to a couple of seconds; do not tune it on a hunch, re-read the ingest rule.
#define CONFIG_INTERVAL_MS 500UL
// Serial per-channel snapshot at 4 Hz, set in the .ino.

// ---------------------------------------------------------------------------
// RELAY OUTPUT + RULES (see MUST_READ.md section 11)
// Relays are now driven, but only ever to the level that keeps power ON. The
// bench wiring is NC (see the RELAY_POWER_ON_LEVEL note below), so the safe
// level is HIGH and the pins are booted HIGH in setup() before anything else
// runs: an unconfigured GPIO is an input, and an input left floating is not a
// state anyone should trust with 220 V on the other side.
//   1 = relay pins are driven to the desired state (boots HIGH = power ON)
//   0 = framework rules do not evaluate and cannot shed or trip anything
//   1 = telemetry is posted once a second
//
// RULES_ENABLED is still 0, so nothing in the firmware currently commands a
// pin LOW. Enabling relay output is therefore safe on this rig ONLY because of
// the NC wiring; on a NO-contact build, leave this 0 until FR-01..FR-12 run.
//
// *** DELIBERATE DIVERGENCE FROM THE OPERATOR'S REFERENCE SKETCH ***
// test2aV2.ino drives the relays ITSELF: inside its sensor task it keeps a
// per-channel `tripped_n` latch and writes each pin LOW the moment that
// channel's watts reach its limit or the total reaches totalWattageLimit, with
// no reset path on the device. That logic is DELIBERATELY NOT PORTED here, and
// must not be ported by anyone reading the sketch as the reference for this
// firmware.
//
// Why: this rig has exactly one authority for shed and trip decisions - the
// backend framework (FR-01..FR-12), which owns priority order, hysteresis,
// restoration and the audit trail. Two authorities on the same relays is not
// redundancy, it is two writers with different state: the device latches a trip
// it cannot clear, so the dashboard would show an outlet the operator restored
// still dead, and every command from the server would fight the latch for the
// pin. The sketch's latch has no clear, so that failure is permanent until a
// reflash - which is exactly the "nothing happens" class of fault the relay
// pin order was already corrected for once.
//
// The limits that sketch hardcodes (1100 W per outlet, 4400 W total) are NOT
// lost by not porting its trip logic: they live in the backend seed
// (PowerSystemConfig.MaxCapacityWatts / WarningThresholdWatts /
// CriticalThresholdWatts, and each outlet's AllowanceWatts), which is where the
// framework reads them from and where an operator can change them without a
// reflash. The firmware observes limits through syncConfig(), which is the
// correct place for them on a server-authoritative rig.
// ---------------------------------------------------------------------------
#define RELAY_OUTPUT_ENABLED 1
#define RULES_ENABLED 0
#define TELEMETRY_ENABLED 1

// ---- I2C bus (INA226 only - the CT ADC moved to SPI) ----
// Bench wiring: SDA = GPIO 8, SCL = GPIO 9. The ADS1220 is on SPI, so this bus
// now carries the INA226 and nothing else; the pins are fixed by the hardware,
// not chosen.
#define I2C_SDA_PIN 8
#define I2C_SCL_PIN 9
// I2C bus speed. 100 kHz is what this wiring sustains RIGHT NOW: measured on
// the current hardware, a 400 kHz build found NEITHER the INA226 (0x40) nor the
// previous ADS1015 (0x48), while a 100 kHz build found both. The ADS1015 is
// gone from this rig (the ADS1220 replaced it over SPI), but the INA226 is the
// only I2C device left and it was last observed ACKing at this rate, so the
// speed stays at the last configuration actually observed talking to a sensor.
//
// CONFIRMED ON THE BENCH (live serial read of the physical ESP32 on COM12):
// that board is running a stale pre-d847000 build which contains NO
// Wire.setClock() call at all, so it ran at the ESP32 default of 100 kHz - and
// it ACKed the INA226 at 0x40 with TI manufacturer ID 0x5449 / die ID 0x2260.
// DO NOT raise this on a hunch. Revisit only with short leads and stronger
// pull-ups, verified by an actual bus scan.
#define I2C_CLOCK_HZ 100000

// ---- INA226: 3.3 V RAIL MONITOR (mains is now a fixed constant) ----
// ROLES REASSIGNED BY OPERATOR DIRECTION, 2026-10-16. Two changes of role:
//   BEFORE: the INA226 sat on a 24 V DC rail behind a divider and was BOTH the
//           mains voltage reference (busV x 9.46) and the outlet-5 USB reading.
//   AFTER:  mains is a FIXED 238 V constant (MAINS_FIXED_VOLTS, below). The
//           INA226 is ONLY the 3.3 V rail monitor, and its bus pin is
//           expected to read ~3.3 V, not ~24 V.
//
// The INA226 is still NOT a mains power meter (MUST_READ.md section 12). Its
// bus/current/power registers describe ONE DC rail and must never be used as a
// mains total, as a P_total, or as the basis for any CH1-4 channel's wattage
// (see the BRANCH_CT_COUNT note below). Every CH1-4 volt and watt figure now
// comes from MAINS_FIXED_VOLTS, so no CH1-4 number depends on the sensor at all.
//
// WHAT THE INA226 NOW DOES (5-channel rig), ONE job:
//   USB rail monitor. outletId 5 posts volts = inaBusVoltage_V, amps =
//   inaCurrent_A, watts = that product, and doc["ina"] posts the same four raw
//   figures. The divider is no longer part of any calculation.
//
// HARDWARE EXPECTATION - READ THE LIVE BUS READING BEFORE TRUSTING CH5:
//   the module is expected to be wired across the 3.3 V rail and report
//   ~3.3 V at its bus pin (2026-10-16: the operator's reference sketch labels
//   this rail "INA226 3.3V Rail", which supersedes the 5 V USB rail label the
//   previous revision of this file used). If the serial line reads ~5 V the
//   module is on the USB 5 V rail instead, and if it still reads ~24 V it is
//   PHYSICALLY STILL ON THE 24 V RAIL and must be rewired. Do not fudge a
//   constant to make that number look right: a wrong bus voltage with the
//   right-looking telemetry is worse than an obviously wrong one.
//
//   - MUST CHANGE if a different shunt is fitted: INA226_MAX_CURRENT_AMPS /
//     INA226_SHUNT_OHM must be re-checked against the shunt actually in the
//     path. They are 0.75 A / 0.1 Ohm: 75 mV shunt full-scale, inside the
//     INA226's +/-81.9 mV input range with margin for shunt tolerance.
//   - DOES NOT CHANGE: the CH1-4 CT chain (ADS1220, ZMCT_CAL_FACTOR, the
//     piecewise curve, the adaptive EMA). Current is measured by the CTs and is
//     entirely independent of the INA226 and of MAINS_FIXED_VOLTS.
#define INA226_ADDR 0x40

// ---- Mains voltage: FIXED CONSTANT ----
// The single mains voltage every CH1-4 volt and CH1-4 watt is derived from.
// Operator direction 2026-10-16: mains is a fixed constant and is no longer
// derived from the INA226. PROVENANCE: originally a bench multimeter reading on
// this rig (228 V, matching the value the old busV x 9.46 derivation produced),
// frozen as a constant so a sensor fault, a rewire, or an absent module can no
// longer move the number every watt in the telemetry is multiplied by. It now
// reads 238 V, adopted from the operator's reference sketch - see the change
// note and the unresolved provenance conflict immediately below.
//
// This is an ASSUMPTION held constant, not a measurement - there is no voltage
// transformer on this rig and the CTs measure current only. Re-measure with a
// meter if the supply is ever changed.
//
// 228.0 -> 238.0 (2026-10-16, adopted from the operator's reference sketch
// test2aV2.ino, which carries `float acVoltage = 238.0`).
// *** CONFLICTING PROVENANCE - RESOLVED BY DIRECTION, NOT BY MEASUREMENT ***
// The 228 V this constant previously held was set from a bench multimeter
// reading on THIS rig. The reference sketch says 238.0 with no recorded
// measurement behind it, and it is 4.4% higher, so every CH1-4 watt figure
// moves by the same 4.4% the moment this change lands. 238 is in force because
// that is the direction given; it is NOT a claim that the meter was wrong.
// ACTION REQUIRED BEFORE THE NEXT THRESHOLD DECISION: re-measure mains with a
// multimeter on this rig and write the reading here. If the meter still says
// 228, this constant goes back and the reference sketch is what is wrong.
#define MAINS_FIXED_VOLTS 238.0f

// SUPERSEDED - KEPT AS HISTORY, DO NOT USE.
// INA226_MAIN_VOLT_DIVIDER was the bus-voltage divider ratio, calibrated on
// the bench when the INA226 sat on a 24 V DC rail: the sensor reported 24.1 V
// at its bus pin, mains measured 228 V with a multimeter, so 228 / 24.1 = 9.46.
// IT IS NOW UNUSED BY DESIGN, because mains is the MAINS_FIXED_VOLTS constant
// above and the INA226 is only the 3.3 V rail monitor. Nothing in the .ino
// multiplies by this number any more.
// It is deliberately NOT deleted: it is the record of how 228 V was originally
// established, and it is the number to compare against if the sensor is ever put
// back in a mains-referenced path. DO NOT "restore" it into the voltage path
// without re-calibrating on mains with a multimeter in the same pass.
// Kept as a defined constant so a stale reference still compiles and is visible
// in a grep, rather than disappearing and taking its provenance with it.
#define INA226_MAIN_VOLT_DIVIDER 9.46f

// Shunt calibration. The INA226 derives current from the shunt voltage, so the
// shunt value scales EVERY current and watt reading - a wrong shunt value on a
// healthy sensor is indistinguishable from a dead sensor on the dashboard.
//
// The physical shunt is 100 mOhm. The INA226 shunt input is limited to
// +/-81.9 mV, so max current must satisfy Imax * Rshunt <= 81.9 mV. A 0.75 A
// range requests 75 mV and leaves margin for shunt tolerance. The old 2 A /
// 100 mOhm pair requested 200 mV; the library rejected calibration and left
// computed current and power at zero even while raw shunt millivolts changed.
// The shunt is a component on the board, read from its marking, not a bench fit.
//
// Consequences to keep in mind before trusting a CH5 reading:
//   - Past ~0.75 A the INA226 saturates at the ADC. A fault on the rail that draws
//     more than 0.75 A will therefore read as a flat maximum rather than as an
//     over-range flag. CH5 has no relay (USB_OUTLET_NO_RELAY), so nothing on
//     the rig will open a breaker for it - watch this rail, do not trust it to
//     detect its own overload.
//   - MAINS_FIXED_VOLTS and the CH1-4 CT chain are untouched by any of this:
//     current on those channels is measured by CTs, not by this sensor.
#define INA226_MAX_CURRENT_AMPS 0.75f
#define INA226_SHUNT_OHM 0.1f
// NOTE (2026-10-16, mains is now fixed): this value is now IDENTICAL to
// MAINS_FIXED_VOLTS - it is 238.0 either way (it was 228.0 until the same pass
// that moved MAINS_FIXED_VOLTS to the reference sketch's 238.0). It is kept as
// a separate name because it still means something different:
// FALLBACK_MAINS_VOLTS is the value a degraded rig reports when a sensor is
// missing, MAINS_FIXED_VOLTS is the value a healthy rig reports. Today those
// two numbers coincide, and that is the POINT: there is no longer a sensor
// failure that can move the mains figure away from the configured mains. If
// MAINS_FIXED_VOLTS is ever re-measured, change this one too or the fallback
// path will start reporting a different mains than the normal path, which is
// exactly the split that used to put 228 V next to 238 V-derived watts on the
// dashboard. They were left divergent for exactly one revision and are not
// again.
#define FALLBACK_MAINS_VOLTS 238.0f

// ---- ADS1220: 24-bit SPI ADC, one ZMCT103C per mains branch ----
// The ADS1015 is gone: this rig reads branch current from an ADS1220 on its own
// SPI bus, so the CT channels no longer share the I2C bus with the INA226. The
// pin values below are the fixed wiring on the board, not free choices - check
// them against the schematic before rewiring anything.
#define ADS1220_CS_PIN 10     // chip select
#define ADS1220_DRDY_PIN 14   // data-ready output, polled by the read path
#define ADS1220_SCLK_PIN 12   // SPI clock
#define ADS1220_MISO_PIN 13   // ADS1220 DOUT -> ESP32 MISO
#define ADS1220_MOSI_PIN 11   // ESP32 MOSI -> ADS1220 DIN
// 4 MHz: the ESP32-S3 default VSPI pins are not used here, so the bus is
// remapped in the constructor and this is the only clock control there is.
// 4 MHz is comfortably inside the ADS1220 limit (10 MHz) and leaves the core-1
// loop undisturbed at 1 kHz conversion rates.
#define ADS1220_SPI_CLOCK_HZ 4000000UL

// PGA and reference. The ZMCT103C modules output a 2.5 V-biased AC ripple, so
// the input range must cover 2.5 V plus signal: the internal 2.048 V reference
// would clip the positive half-cycle and the RMS would read low in a way that
// looks exactly like a bad calibration factor. AVDD (~3.3 V) is used as the
// reference with gain 1 for +/-3.3 V. The library names below are ADS1220_WE
// enum values, which is why this header must be included AFTER the library.
#define ADS_PGA_GAIN ADS1220_GAIN_1
// Normal mode tops out at 475 SPS, which cannot cover a 4 x 250 sample pass
// inside the sweep period. Turbo mode DR level 5 should be 2000 SPS.
//
// MEASURED 2026-10-15: the pass takes ~1131 ms, i.e. ~940 us per conversion
// (~1060 SPS), so either the DR field is not in force or each blocking read
// carries DRDY latency on top of the conversion. That is why sensorTask()
// bounds its own duration and forces a delay: a pass that overruns the period
// leaves IDLE0 no scheduler slot and the task watchdog reboots the rig, which
// it did on this bench before the guard existed. Re-measure with the "[ADC]
// self-test" boot line before trusting the 600-sample window length here.
#define ADS_OP_MODE ADS1220_TURBO_MODE
#define ADS_DATA_RATE ADS1220_DR_LVL_5
// Reference source. 1 = AVDD (~3.3 V) is calibrated and used as VREF, which is
// what makes the gain-1 range above cover the CT's 2.5 V bias. 0 = the internal
// 2.048 V reference, which clips this signal. The .ino calls
// setAvddAvssAsVrefAndCalibrate() only when this is 1.
//
// MEASURED 2026-10-15 on the bench, and it is the one number here that was NOT
// as assumed: with this flag at 1 the ADC reported VREF = 2.0550 V, not ~3.3 V.
// Either the module's analog supply really is ~2.05 V, or the internal
// AVDD/AVSS measurement is not trustworthy in this wiring. Either way the input
// range sits BELOW the CT's 2.5 V DC bias, so the top of every cycle is clipped
// and the mV RMS figures are distorted at the source. Do NOT re-derive
// ZMCT_CAL_FACTOR until VREF is genuinely above the bias (external VREF on
// REFP0/REFN0, or the module supply corrected). The boot line
// "[ADC] VREF=..." prints it on every flash, so re-check it before trusting any
// amps figure.
#define ADS1220_USE_AVDD_AS_VREF 1

// ---- ZMCT103C CT calibration factor: provenance ----
// This is amps RMS per volt RMS at the CT output. It is the ONE constant in the
// current path that cannot be derived from a datasheet, and the only honest way
// to set it is a measured known load. Whenever it changes, write here:
//   - the date,
//   - the load (what was clamped on, and its meter-measured watts),
//   - the mains volts the run saw (now the fixed MAINS_FIXED_VOLTS constant - it
//     no longer comes from the INA226),
//   - the resulting counts/mV that run printed.
// Without those four, this is a magic number, and a magic number in a mains
// measurement chain is exactly what the rest of this file exists to prevent.
//
// HISTORY:
// 2026-10-13 (ADS1015, 12-bit, +/-6.144 V, I2C): factor 0.52 measured on a
//   4-channel rig. The four wired channels read 0.059 / 0.029 / 0.024 / 0.025 A
//   against ~300 W per outlet expected (~1.37 A at 228 V), i.e. roughly 25x low
//   - so even the 0.52 was fitted to a rig whose own numbers were in doubt.
// 2026-10-15 (ADS1220, 24-bit, +/-3.3 V single-ended, SPI, AVDD VREF): the ADC
//   changed, so 0.52 was carried over UNVERIFIED. Live run on the 2-outlet rig
//   (CH1/CH2, 600-sample window, 227.5 V mains from the INA226):
//     CH1  counts 1961988.6  mV_rms 480.649  -> 0.2499 A  (55.0 W)
//     CH2  counts  712108.4  mV_rms 174.453  -> 0.0907 A  (20.3 W)
//   NO FACTOR WAS WRITTEN from that run, for two independent reasons:
//     1. No known load was clamped on, so there was nothing to check 0.52
//        against. Measuring the rig's own wattage against a factor derived from
//        that rig's wattage is circular and proves nothing.
//     2. The run also printed VREF = 2.0550 V (see ADS1220_USE_AVDD_AS_VREF),
//        while the CT modules are biased at 2.5 V DC. Full scale below the bias
//        means the waveform is half-clipped at the ADC, so those mV figures are
//        distorted at the source and calibrating against them would bake the
//        clipping into the constant. Fix the reference/range question FIRST.
//   See ZMCT_CALIBRATION_MODE below - it is PRINT ONLY and is the supported way
//   to re-derive the factor once a known load and a valid input range exist.
// 2026-10-16 (ADS1220, SAME ADC, meter-verified SINGLE POINT): factor 0.52 -> 2.15.
//   Load: one laptop on ONE branch (CH1), clamp meter measured 0.33 A true at
//   228 V mains (MAINS_FIXED_VOLTS). Before this change the rig reported 0.08 A on
//   that same branch, i.e. 4.125x low, so the new factor is
//   0.52 x 0.33 / 0.08 = 2.145, rounded to 2.15.
//   It was derived with ZMCT_CALIBRATION_MODE 1 for one flash to capture the
//   counts / mV_rms chain, then the mode was put back to 0 (the shipping value).
//
//   *** SINGLE-POINT AND LOAD-SPECIFIC - DO NOT TRUST IT OUTSIDE THIS LOAD ***
//   It is one equation fitted at one current on one load. It is NOT a validated
//   amps-per-volt transfer function, because the input chain is still nonlinear:
//   VREF is 2.055 V (see ADS1220_USE_AVDD_AS_VREF) while the ZMCT103C output
//   sits on a ~2.5 V DC bias, so the top of every AC cycle is CLIPPED at the
//   ADC. Clipping compresses the waveform before it is RMS'd, and the amount of
//   compression depends on the signal amplitude, so the mV->amps ratio is
//   amplitude-dependent by construction. A factor that lines up one point at
//   0.33 A therefore says very little about 0.05 A or 2 A.
//   It also inherits that 0.52 was itself fitted on a rig whose own numbers were
//   in doubt (see the 2026-10-13 entry), so this is 0.52 x a correction, not an
//   absolute measurement.
//
//   REQUIRED NEXT STEP, and it is not optional: after the VREF/range fault is
//   fixed, RE-DERIVE this constant from scratch with TWO known loads of
//   different current (e.g. ~0.3 A and ~1.5 A), confirm the implied A/V agrees
//   at both, and only then overwrite this value. Until that two-load check
//   passes, treat every CH1-4 amps and watt figure as bench-only, and do NOT
//   stack a second correction factor on top of this one to make a different load
//   read right - two fitted constants multiply into a curve that belongs to
//   neither of them. If a reading disagrees with the meter, report the numbers.
//
// POST-CHANGE OBSERVATION, 2026-10-16, SAME SESSION, RESULT: NOT VERIFIED.
//   The loaded branch turned out to be CH2 (AIN1), NOT CH1 - CH1/CH3/CH4 read
//   0.000 A (under 3 mV_rms of noise) throughout the capture. With 2.15 in
//   force CH2 read 0.40-0.50 A (counts 0.79M-0.97M, mV_rms 194-239) against
//   the clamp meter's 0.33 A, i.e. roughly 25-50% HIGH and swinging that far
//   between sweeps - OUTSIDE the 0.30-0.35 A this factor was meant to produce.
//   Note applyPiecewiseCalibration() takes 0.9635 of the raw figure above
//   ZMCT_MID_RANGE_AMPS; that is part of the gap and is NOT part of the factor.
//   TWO SEPARATE PROBLEMS, neither of them fixed here:
//     1. the 0.08 A this factor was scaled from does not follow from the mV
//        this build now reads - 4.135x on 0.45 A is 0.11 A, not 0.08 A - so
//        either the pre-change reading was taken at another point in the load's
//        cycle, or the load is not steady (the swing above says it is not);
//     2. the VREF clip makes mV->amps amplitude-dependent, which is exactly why
//        a single point does not transfer to another current.
//   NO SECOND CORRECTION WAS STACKED ON TOP OF 2.15, deliberately. Chasing this
//   with another factor hides both causes instead of fixing either. Treat 2.15
//   as UNVERIFIED until the VREF/range fault is fixed and the two-load
//   re-derivation below is actually run.
#define ZMCT_CAL_FACTOR 2.15f

// ---- CT calibration bench mode (print-only, zero behavioural effect) ----
// 0 = off, normal firmware (this is the shipping setting).
// 1 = the serial log additionally prints, per CT channel, the UN-calibrated
//     measurement chain: ADC-count RMS, the equivalent mV RMS, the amps the
//     current ZMCT_CAL_FACTOR implies from those mV, and (when a reference
//     wattage is set below) the factor that WOULD make that channel report
//     exactly the known load. It also prints the ADC configuration actually in
//     force (VREF volts, PGA gain factor, mV per code) once at boot, which is
//     what replaced the deleted ADS1015 register pre-flight. It only prints:
//     sampling, the piecewise curve, the adaptive EMA, the noise floor and the
//     posted telemetry are all untouched, so the bench can run mode 1 against a
//     live rig safely and leave the dashboard posting the whole time.
//
// HOW TO USE IT (the workflow this mode exists for):
//   1. Clamp ONE known load onto ONE branch. Measure its real watts with a
//      meter - the rig's own wattage column cannot be the reference, it is
//      derived from the factor being calibrated.
//   2. Put that measured wattage in ZMCT_CAL_REF_WATTS below and reflash.
//   3. Read 'suggested=' for that channel off the serial log. That is the A/V
//      that makes the channel report exactly the known load.
//   4. Write it into ZMCT_CAL_FACTOR, add the date + the load to the provenance
//      block above, and set ZMCT_CALIBRATION_MODE back to 0.
//   If the channel prints NO SIGNAL, stop: that is a CT / wiring / ADC-config
//   fault, and a factor change would bury it.
#define ZMCT_CALIBRATION_MODE 0
// Known load on the branch under test, in W. 0.0 = no reference load applied,
// so no suggested factor is printed (only the raw chain). Set this to the
// measured wattage of the reference load (e.g. a clamped 1 A lamp bank) while
// in mode 1, and read the suggested factor straight off the serial log.
// Back to 0 whenever no calibrated load is actually clamped on: a stale non-zero
// value here makes the firmware print a confident, wrong "suggested=" number.
#define ZMCT_CAL_REF_WATTS 0.0f
// Noise floor: raw readings below this are treated as 0 A so idle channels do
// not show phantom jitter that would keep FR-10 idle detection awake.
#define ZMCT_NOISE_FLOOR_AMPS 0.010f
// Above this fraction of the low range the mid-range factor applies, which is
// what keeps a 0.264 A reading from being reported as 0.274 A.
#define ZMCT_MID_RANGE_AMPS 0.080f
#define ZMCT_MID_RANGE_FACTOR 0.264f / 0.274f
// Adaptive filter: a step larger than this snaps through untouched, so a load
// change is visible at once instead of being smoothed into staleness. Anything
// smaller is smoothed (1 - ADAPTIVE_EMA_HISTORY old, ADAPTIVE_EMA_HISTORY new).
#define ZMCT_ADAPTIVE_STEP_AMPS 0.015f
#define ZMCT_ADAPTIVE_EMA_HISTORY 0.7f
// Samples per channel per pass. WAS 600, sized for a 2-channel sweep.
//
// MEASURED 2026-10-15 on this ADC: one blocking single-shot conversion costs
// ~940 us (the boot "[ADC] self-test" line prints the real figure on every
// flash - re-read it). So a 600-sample window is ~564 ms PER CHANNEL: 2
// channels fit the old 1 s sweep, 4 channels would need ~2.3 s and would leave
// core 0 occupied almost continuously, which is the condition that starved
// IDLE0 and rebooted the rig with a task watchdog abort (see sensorTask() in the
// .ino).
//
// So the window is now 150 samples (~141 ms/channel at the measured ~940 us per
// conversion, ~9 AC cycles at 60 Hz), which is the operator's reference-sketch
// value and the shortest window that still spans two full 60 Hz cycles' worth of
// nominal mains content. The sweep period below is unchanged at 2 s, so the
// four-channel pass now costs ~564 ms instead of ~940 ms against the same
// period: comfortably under the METER_INTERVAL_MS/2 guard, and the extra slack
// is deliberate - the watchdog path must never engage on a healthy rig.
//
// WHAT 150 COSTS, stated plainly: the RMS window is shorter than the 250-sample
// one it replaces, so a genuinely noisy branch is averaged over fewer cycles and
// its reading is correspondingly noisier. That is a real accuracy trade for a
// real reduction in core-0 occupancy. The adaptive EMA in front of it smooths
// the readout but does not recover the lost averaging, so per-sweep scatter on
// a live branch will be larger than it was at 250 samples. If that scatter turns
// out to be objectionable on a real load, raising the window is the fix - and
// the sample cost must be re-checked against METER_INTERVAL_MS at the same
// time, because that is what the watchdog guard is actually watching.
//
// The visible consequence of the 2 s period: branchAmps only refreshes every 2 s
// while telemetry posts every 1 s, so the dashboard can show one repeated amps
// frame between updates. That is a stale-but-true number, which is the honest
// trade - the alternative is a sweep that overruns its own period and stops
// posting altogether.
#define ZMCT_DEDICATED_SAMPLES 150
// Stack for the sampling task; it is pinned to core 0 so a full four-channel
// pass cannot delay the serial output on core 1.
#define SENSOR_TASK_STACK 4096
#define SENSOR_TASK_PRIORITY 2
// How many ADS1220 channels actually have a CT wired (0..4). CH1-CH4 on this
// rig, one CT each: AIN0, AIN1, AIN2, AIN3. The FIFTH outlet (outletId 5, the
// USB socket) has no CT and never will - it is measured by the INA226, which
// reports a real volts and a real amps rather than a fabricated zero. So
// BRANCH_CT_COUNT is OUTLET_COUNT - 1 by construction, and the firmware posts
// OUTLET_COUNT readings from BRANCH_CT_COUNT CT channels plus the INA226.
//
// If a channel is ever added without a CT, do NOT derive its current as a
// residual (mains total minus the measured branches): the INA226 is not on the
// mains feed (see the INA226 note above), so no mains total exists here to
// subtract from, and a fabricated residual would be a lie in the telemetry.
#define BRANCH_CT_COUNT 4
// Per-branch overcurrent trip in amps RMS, evaluated by FR-03 on the board.
#define BRANCH_OVERCURRENT_AMPS 5.0f

// How often the sensor sweep runs. WAS 1000 ms, sized for a 2-channel pass;
// DOUBLED to 2000 ms with the 4-CT rig because each blocking channel window is
// now ~141 ms (ZMCT_DEDICATED_SAMPLES = 150), i.e. ~564 ms for all four. The RMS
// window is blocking by nature, so the sweep is deliberately NOT run every loop
// iteration: core 0 would be occupied almost continuously and telemetry would
// stutter. The main loop keeps spinning at full speed between sweeps and the
// dashboard still sees a reading on every telemetry batch. The sweep is on SPI
// and the INA226 on I2C, so the two no longer contend for a bus (see the
// i2cMutex note in the .ino).
//
// If this period ever needs to go back toward 1 s, ZMCT_DEDICATED_SAMPLES has to
// come down with it - the pass duration, not the period, is what starves IDLE0.
#define METER_INTERVAL_MS 2000UL

// How often the INA226 is read. It is the 3.3 V RAIL MONITOR (see above), not
// a mains meter and not a mains voltage reference any more, so it does not need
// a fast sample rate: the rail voltage and its load change on the order of
// seconds, not milliseconds. Polling it on a fixed interval rather than on every
// loop() iteration keeps a core-1 pass from grabbing the I2C lock repeatedly
// (loop() runs thousands of times a second).
#define INA226_POLL_INTERVAL_MS 250UL

// Placeholder for bench tests without hardware wired:
// 0 = read the real INA226 + ADS1220 on the wired bench.
#define SIMULATE_METERS 0

// (No I2C pin-hunt diagnostic exists any more. The DIAG_PIN_HUNT switch was
// removed because the stale pre-d847000 build on the bench ESP32 is still
// stuck inside exactly that loop: it scans for the sensors, never reaches the
// measurement path, and never posts telemetry. The bus is now known-good at
// I2C_SDA_PIN / I2C_SCL_PIN / I2C_CLOCK_HZ (verified by ACK on COM12), so a
// pin hunt is not a diagnostic anyone should be tempted to re-enable.)

// Provenance reported to the backend with every telemetry batch (D8). The
// backend labels the dashboard charts from this instead of hardcoding a claim,
// so the UI stays honest in both bench and metered states. The value posted is
// derived from SIMULATE_METERS: 1 = Simulated, 2 = Metered (INA226 + ADS1220
// actually read on the bench).
#define REPORT_METERING_MODE

// ---- Relay outputs, one per mains outlet channel ----
// Live rig order: CH1-CH4 = the four 220 V outlets, CT-metered. CH5 = the USB
// socket, which has NO RELAY: RELAY_PINS[4] is reserved but never driven (see
// USB_OUTLET_NO_RELAY below).
//
// Exclusion banks this table has to clear on the ESP32-S3, all checked for the
// pins in use:
//   I2C   8, 9          (INA226 SDA/SCL)
//   SPI   10-14         (ADS1220 CS/DRDY/SCLK/MISO/MOSI)
//   strapping 0, 3, 45, 46
//   USB-JTAG 19, 20
//   GPIO 1, 2, 4, 5 clear ALL of the above. They are ordinary GPIOs on the
//   ESP32-S3 (not strapping, not ADC-only, not in the octal-PSRAM pin set,
//   which the N16R8 module uses at 26-32 and 35-37), so nothing else on this
//   board claims them.
//
// GPIO 1 CHECKED, NOT ASSUMED (2026-10-15, re-confirmed 2026-10-16): on the
// ESP32-S3 the strapping pins are 0, 3, 45 and 46 only. GPIO 1 is an ordinary
// GPIO (ADC1_CH0), is not in the USB-JTAG pair (19/20), is not a PSRAM pin on
// the N16R8 module, and is not touched by the boot loader on this board. There
// is NO conflict, so CH1 = GPIO 1 is fine - do not remap it on suspicion. It is
// still worth knowing that it is an ADC1 pin, so it cannot be sampled by ADC2
// while ADC1 is busy; that does not affect a digital output.
//
// RELAY ORDER CORRECTED 2026-10-16 from the operator's own wiring, measured on
// the rig: outlet 1 = GPIO 1, outlet 2 = GPIO 2, outlet 3 = GPIO 4, outlet 4 =
// GPIO 5, USB (outlet 5) = no relay. The table previously read {2, 1, 4, 5, 6},
// i.e. CH1 and CH2 were SWAPPED - a command for outlet 1 cut outlet 2 instead,
// which is what made disconnect commands look unresponsive. The {4, 5} tail was
// already right.
//
// VERIFY BEFORE POWERING: the exclusion-bank argument above is
// correct-by-construction but NOT an observation of the physical board, and the
// per-outlet proof now required is stricter than "it clicks": a relay is only
// proven for an outlet when that outlet's OWN CT current drops to zero on its
// disconnect and returns on reconnect. Change this table and the RELAY_PIN_n
// aliases together - the static_asserts below exist precisely because those two
// descriptions of the same wiring are the easiest pair in this file to edit and
// forget the other one of.
//
// VOLTAGE: the ESP32-S3 drives 3.3 V. A 5 V relay module with a 4N35/PC817
// input still pulls its coil in at 3.3 V (the opto LED threshold is ~1.2-1.4 V),
// but a module whose series resistor was sized for 5 V delivers noticeably less
// coil current and can buzz or fail to latch. If a relay does not audibly
// click, put a transistor or level shifter in front of it - or power the opto
// from VCC with the ESP32 side pulled low - rather than raising the ESP32 pin,
// which is not possible at 3.3 V anyway.
// Operator wiring, corrected 2026-10-16 (was {2, 1, 4, 5, 6} - CH1/CH2 swapped).
// Index 4 is the USB socket placeholder and is NEVER driven (USB_OUTLET_NO_RELAY).
static constexpr uint8_t RELAY_PINS[OUTLET_COUNT] = { 1, 2, 4, 5, 6 };
// Named single-outlet aliases, because the wiring order (board header) and the
// channel order (dashboard CH1 first) are not the same thing and a bare
// RELAY_PINS[i] index hides that. RELAY_PIN_1 -> CH1, ..., RELAY_PIN_5 -> CH5.
#define RELAY_PIN_1 1
#define RELAY_PIN_2 2
#define RELAY_PIN_3 4
#define RELAY_PIN_4 5
// Placeholder only - the USB socket has no relay, so this value is never
// pinMode'd or driven. Kept as 6 purely so the index exists; see
// USB_OUTLET_NO_RELAY.
#define RELAY_PIN_5 6

// ---- USB outlet (outletId 5) is MONITORED ONLY ----
// The socket has no relay behind it on this rig, so index 4 of the arrays above
// is a RESERVED PLACEHOLDER and nothing in the firmware drives it: setup() does
// not pinMode it, applyRelays() skips it, syncConfig() ignores a backend
// desiredStatus for channelId 5, and its reported relayClosed is pinned true.
// That is deliberate and is the honest thing to post: claiming to switch a
// socket that has no switch would let the dashboard show "disconnected" while
// the USB load is still drawing current.
//
// 1 = the last channel (outletId OUTLET_COUNT) is monitored-only and is never
// 0 = every outlet has a relay and the whole table is driven.
// If a relay IS later fitted behind the USB socket, set this to 0 and give it a
// real pin - but do not reuse GPIO 6 as-is without confirming nothing else on
// the board wants it.
#define USB_OUTLET_NO_RELAY 1

// ---- Relay-transition window drop (2026-10-16) ----
// NO NEW TUNABLE. This block documents a mechanism that lives entirely in
// applyRelays() + sensorTask() in the .ino, precisely because it must NOT be a
// knob: every knob that touches the measurement chain (the window length, the
// EMA weights, the noise floor, ZMCT_CAL_FACTOR) is a calibration constant, and
// none of them is what was wrong.
//
// THE FAULT (observed live on this rig, 2026-10-16): toggling CH1 through the
// dashboard posted a phantom 792 W / 3.33 A on a branch whose entire peak
// history was 127 W. The 792 W was never measured. readChannel() computes a
// MEAN-SUBTRACTED variance over a 150-sample window, and if that window spans a
// relay open/close then it contains samples from two different steady states.
// The variance of two levels joined by a step is dominated by the step itself,
// not by the AC ripple, so the window reports an RMS of the transition. Two
// things then made it worse: the adaptive EMA snaps through any step larger
// than ZMCT_ADAPTIVE_STEP_AMPS, so the fake value passes the filter untouched
// and then lingers; and watts = amps x MAINS_FIXED_VOLTS scales it straight to a
// number no electrician would believe, on the dashboard, as a real spike.
//
// THE MECHANISM (three lines of behaviour, in the .ino):
//   1. applyRelays() bumps a version counter whenever a pin level ACTUALLY
//      changes (writing the same level again is not a transition and costs
//      nothing).
//   2. sensorTask() samples that counter before opening each channel window and
//      compares it after the window closes.
//   3. If it moved, that channel's window is DISCARDED: the previous amps are
//      posted, the raw chain is zeroed and flagged stale, and the next sweep -
//      the first clean window after the transition - publishes normally.
//
// WHAT THIS DELIBERATELY DOES NOT DO, because each of these was considered and
// rejected:
//   - It does NOT lengthen the window, so ZMCT_DEDICATED_SAMPLES stays at 150
//     and the core-0 occupancy argument above is untouched. A longer window
//     would smooth the step across itself rather than refuse to measure it.
//   - It does NOT latch, delay or retry. One clean window per transition is all
//     the physics needs; anything more turns a 141 ms window into a mechanism
//     for hiding real load changes.
//   - It does NOT change the noise floor, the piecewise curve, the EMA weights
//     or ZMCT_CAL_FACTOR. Every one of those numbers is calibrated against
//     steady-state loads, and a step is not a steady state - the bug was never
//     in them.
//
// COST: one dropped CT reading per channel that transitions mid-window, visible
// on the serial line as "raw STALE-DROPPED" next to the held amps. That is a
// stale-but-true number for ~141 ms, which is strictly better than a wrong one.
// If a real transient ever has to be caught faster than the 2 s
// METER_INTERVAL_MS sweep already allows, that is a sampling-period question for
// the watchdog budget above - not a reason to publish step-contaminated RMS.

// ---- Post-CLOSE settle blanking (CLOSE_SETTLE_WINDOWS) ----
// ONE new tunable, and it is a COUNT OF WINDOWS, not a time and not a
// calibration: how many FULL sweeps after a relay CLOSE have their CT windows
// discarded before the branch is measured and published again.
//
// WHY IT EXISTS - the 2026-10-16 second observation on this rig. The version
// stamp above kills the window that CONTAINS a transition, and that alone left
// a residual spike: a 792 W / 3.33 A phantom was still seen on the GUI for one
// to two batches after a CH1 close, while the branch's entire 15-minute history
// peaked at 121 W. The spanning-window drop is not sufficient, because a CLOSE
// does not end when the pin changes level. Two physical effects outlive it:
//   - CONTACT BOUNCE. The mechanical contacts make/break several times over
//     milliseconds around the transition, so the window AFTER the spanning one
//     can still straddle a residual step.
//   - CAPACITIVE INRUSH. Switching a load on charges its input capacitance
//     (switch-mode PSU bulk caps, motor/transformer windings, lamp filaments),
//     which is a real current surge for the first few AC cycles and is settled
//     well before the branch reaches its steady draw.
// Both are exactly what the mean-subtracted RMS reports as signal, and the
// adaptive EMA snaps through anything above ZMCT_ADAPTIVE_STEP_AMPS, so the
// fake value is published untouched and then lingers.
//
// WHICH DIRECTION. CLOSE ONLY, and the asymmetry is deliberate:
//   - CLOSE is the noisy direction (bounce + inrush), so it gets the extra
//     blanked window.
//   - OPEN keeps the existing single spanning-window drop. Cutting a load
//     removes current immediately; there is no inrush, and the residual
//     settling that does exist decays toward zero - which is the safe
//     direction to publish. Blanking OPEN too would hide the operator's own
//     disconnect taking effect for longer than it already takes, for no
//     measured benefit.
//
// WHAT IT IS NOT: it is not a latch (nothing holds the channel until some later
// event clears it - it is a fixed window count), it is not a delay or a retry
// loop, and it does not touch the window length, the piecewise curve, the EMA
// weights, the noise floor, ZMCT_CAL_FACTOR, the PGA or the VREF. None of those
// numbers was ever the fault: they are all calibrated against STEADY-STATE
// loads, and a contact bounce is not a steady state.
//
// 1 = discard the NEXT one full sweep after a close (the spanning window is
//     already discarded by the version stamp, so a close costs at most two
//     held readings, i.e. held values for up to ~2 x METER_INTERVAL_MS).
// 0 = spanning-window drop only, i.e. exactly the previous behaviour.
// Raising it above 1 hides more of a real load ramp for longer and is only
// justified by a measurement, not by suspicion. On this rig the whole close
// transient is gone by the second sweep, so 1 is the setting the bench
// evidence supports; do not climb it because one batch was still settling.
#define CLOSE_SETTLE_WINDOWS 1

// NC (normally closed) contact wiring, as built on the bench:
//   power PASSES while the relay coil is idle  (pin HIGH)
//   driving LOW energises the coil, the NC contact OPENS, power is CUT
// So "energised outlet" in the framework maps to the pin being HIGH, and every
// protective action (shed, trip, master cut) must drive the pin LOW to actually
// remove power. Getting this backwards would report a live outlet as cut.
//
// ACTIVE LEVEL. The two levels above are the electrical contract with the relay
// MODULE, not with the contacts, and the two are independent: a module with an
// active-LOW optocoupler (very common - 4N35/PC817 input on the ubiquitous
// 5 V relay boards) pulls its coil in when the pin is LOW, which INVERTS every
// line above. Set RELAY_ACTIVE_LEVEL_INVERTED to 1 for such a board; the two
// levels below then flip automatically and nothing else in the firmware has to
// know. Leave it at 0 for the board documented above (verified by the audible
// click with the pin HIGH = powered and LOW = cut).
//
// The serial line "[RELAY] CH<n> ... pin=HIGH/LOW" prints the level actually on
// the pin after the write, so the active level can be verified on the bench
// without trusting this comment: drive a disconnect, look at the pin, and only
// then set the flag if the relay did not respond.
// VERIFIED ON THE BENCH 2026-10-15, not assumed: with RELAY_ACTIVE_LEVEL_INVERTED
// = 0 the device drove the CH1 pin LOW on a Disconnect and the CT on that branch
// went to 0.000 A / 0.0 W (the load really was cut), and back to ~0.22 A / 51 W
// when the pin went HIGH again. (That observation was made before the CH1/CH2
// swap was corrected, so it was recorded against the wrong pin number - GPIO2 -
// but the polarity finding is what it was: this board IS high-true, and the flag
// above stays 0. The corrected per-outlet pin mapping is re-proven by CT on
// every outlet, not by the pin number.)
// If someone swaps the relay module for an active-LOW board, this is the number
// to change - and the serial "pin GPIOx=LOW/HIGH" readback is how to notice.
#define RELAY_ACTIVE_LEVEL_INVERTED 0
#if RELAY_ACTIVE_LEVEL_INVERTED
#define RELAY_POWER_ON_LEVEL LOW
#define RELAY_POWER_OFF_LEVEL HIGH
#else
#define RELAY_POWER_ON_LEVEL HIGH
#define RELAY_POWER_OFF_LEVEL LOW
#endif

// ---- Backend outlet status ordinals (GET /api/Device/config) ----
// outlets[].desiredStatus is an OutletStatus ENUM serialised as a NUMBER
// (System.Text.Json default, no string converter):
//   0 Active, 1 Standby, 2 Restricted, 3 Disconnected.
// Only 3 (Disconnected) cuts power. Standby and Restricted still have the outlet
// CONNECTED - the difference is the allowance it may draw, not whether power
// passes - so they map to CLOSED. Treating them as OPEN would silently
// disconnect an outlet nobody asked to disconnect, which is exactly the kind of
// uncommanded load drop this rig must not produce.
#define OUTLET_STATUS_ACTIVE 0
#define OUTLET_STATUS_STANDBY 1
#define OUTLET_STATUS_RESTRICTED 2
#define OUTLET_STATUS_DISCONNECTED 3

// ---- Manual switch inputs, raw rocker/switch caps (0 = not wired) ----
// No switch is wired on this rig. 0 is a real "not connected" marker here, not a
// channel number: GPIO 0 is a strapping pin and must never be used as a switch
// input on the ESP32-S3. The USB socket (index 4) has no switch and no relay
// either, so it is 0 like the rest.
static const uint8_t SWITCH_PINS[OUTLET_COUNT] = { 0, 0, 0, 0, 0 };

// ---- Local autonomy ----
#define LOCAL_AUTO_SHED true
#define FAULT_TRIP_COUNT 3
#define SWITCH_DEBOUNCE_MS 50

// ---- Consistency guards ----
// These descriptions of the same wiring are the easiest pair in this file to
// edit and forget the other one of, and a mismatch here means the telemetry and
// the schematic disagree about which relay is which outlet.
static_assert(RELAY_PIN_1 == RELAY_PINS[0], "RELAY_PIN_1 must match RELAY_PINS[0]");
static_assert(RELAY_PIN_2 == RELAY_PINS[1], "RELAY_PIN_2 must match RELAY_PINS[1]");
static_assert(RELAY_PIN_3 == RELAY_PINS[2], "RELAY_PIN_3 must match RELAY_PINS[2]");
static_assert(RELAY_PIN_4 == RELAY_PINS[3], "RELAY_PIN_4 must match RELAY_PINS[3]");
static_assert(RELAY_PIN_5 == RELAY_PINS[4], "RELAY_PIN_5 must match RELAY_PINS[4]");
// Every outlet needs a real sensor. CH1-CH4 have a CT each; the USB socket
// (outletId 5) is measured by the INA226 instead, so the CT count is one short
// of the outlet count BY DESIGN and never equals it. The old guard
// (BRANCH_CT_COUNT == OUTLET_COUNT) was the 2-channel rig's rule; it fails here
// on purpose, because a 5th CT is not what fills that slot.
static_assert(BRANCH_CT_COUNT == OUTLET_COUNT - 1,
              "CH1-4 are CT-metered; outlet 5 is INA226-metered (monitored-only USB)");
// No relay pin may collide with a sensor bus. These are the fixed wiring, not
// choices, and a relay pin that lands on one of them takes the whole sensor
// chain down with it - so the collision is made a compile error instead of a
// bench mystery.
static_assert(RELAY_PIN_1 != I2C_SDA_PIN && RELAY_PIN_1 != I2C_SCL_PIN,
              "relay pin collides with the INA226 I2C bus");
static_assert(RELAY_PIN_2 != I2C_SDA_PIN && RELAY_PIN_2 != I2C_SCL_PIN,
              "relay pin collides with the INA226 I2C bus");
static_assert(RELAY_PIN_3 != I2C_SDA_PIN && RELAY_PIN_3 != I2C_SCL_PIN,
              "relay pin collides with the INA226 I2C bus");
static_assert(RELAY_PIN_4 != I2C_SDA_PIN && RELAY_PIN_4 != I2C_SCL_PIN,
              "relay pin collides with the INA226 I2C bus");
static_assert(RELAY_PIN_3 != ADS1220_CS_PIN && RELAY_PIN_3 != ADS1220_DRDY_PIN &&
              RELAY_PIN_3 != ADS1220_SCLK_PIN && RELAY_PIN_3 != ADS1220_MISO_PIN &&
              RELAY_PIN_3 != ADS1220_MOSI_PIN,
              "relay pin collides with the ADS1220 SPI bus");
static_assert(RELAY_PIN_4 != ADS1220_CS_PIN && RELAY_PIN_4 != ADS1220_DRDY_PIN &&
              RELAY_PIN_4 != ADS1220_SCLK_PIN && RELAY_PIN_4 != ADS1220_MISO_PIN &&
              RELAY_PIN_4 != ADS1220_MOSI_PIN,
              "relay pin collides with the ADS1220 SPI bus");
// The telemetry loop, the relay loop and relayClosedDesired[] are all sized by
// OUTLET_COUNT. A larger rig (the 13-channel final one) has to widen these
// deliberately, not by truncation: reading past the end of relayClosedDesired[]
// would post a relay state read from whatever is next in memory, and the
// 13-channel rig needs 8 CT-metered channels, which this ADS1220 (4 inputs)
// cannot supply.
static_assert(OUTLET_COUNT <= 5, "widen the arrays deliberately before exceeding the 5-channel rig");
static_assert(BRANCH_CT_COUNT <= 4, "the ADS1220 has 4 single-ended inputs (AIN0..AIN3)");
