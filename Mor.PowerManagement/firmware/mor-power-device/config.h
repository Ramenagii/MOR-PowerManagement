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
//                  volts/amps/watts come straight off the INA226, which now
//                  double-duties as the USB rail monitor and the mains voltage
//                  reference (see the INA226 block below).
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

// ---- INA226: USB rail monitor + mains voltage REFERENCE ----
// MUST_READ.md section 12 still holds: the INA226 is NOT a mains power meter.
// It sits on a 24 V DC rail behind a divider, so its current and power
// registers read ~0 and must never be used as a mains total, as a P_total, or
// as the basis for any CH1-4 channel's wattage (see the BRANCH_CT_COUNT note
// below). Its current/power registers are NOT a USB load measurement either on
// THIS wiring: outlet 5 posts the INA226's own bus volts and shunt current
// because that is the only rail the socket shares with the sensor. If a USB
// load is clamped on, the shunt current that appears on outlet 5 IS that load;
// if the socket is on a different rail than the INA226 shunt, outlet 5 will
// read that other rail's current - check the wiring before trusting an amps
// figure on CH5.
//
// WHAT THE INA226 NOW DOES (5-channel rig), two jobs on one sensor:
//   1. Mains reference. inaBusVoltage_V x INA226_MAIN_VOLT_DIVIDER is the single
//      mains voltage that CH1-4 volts and CH1-4 watts are both derived from.
//      UNCHANGED by the 5-channel expansion.
//   2. USB rail monitor. outletId 5 posts volts = inaBusVoltage_V, amps =
//      inaCurrent_A, watts = that product. It is the raw bus-pin reading, NOT
//      the divided mains value: the divider exists to bring a 24 V rail under
//      the INA226's 36 V limit, and applying it to a USB figure would report a
//      5 V socket as ~47 V.
//
// IF THE INA226 IS REWIRED TO THE 5 V USB RAIL, TWO THINGS CHANGE AND ONE DOES
// NOT. FLAGGED HERE, NOT APPLIED - the divider is left at its calibrated 9.46:
//   - MUST CHANGE: INA226_MAIN_VOLT_DIVIDER would become ~1.0 (or whatever the
//     new resistor ladder gives), and every CH1-4 volt and watt figure in the
//     telemetry would be wrong by 9.46x until it was re-fitted. Re-calibrate
//     with a multimeter on mains and on the 5 V rail together, in one pass.
//   - MUST CHANGE: INA226_MAX_CURRENT_AMPS / INA226_SHUNT_OHM must be re-checked
//     against the shunt actually in the USB path; a USB load will sit far below
//     the 8 A full scale configured for the mains-side shunt.
//   - DOES NOT CHANGE: the CH1-4 CT chain (ADS1220, ZMCT_CAL_FACTOR, the
//     piecewise curve, the adaptive EMA). Current is measured by the CTs and is
//     entirely independent of the INA226, so only the VOLTAGE multiplied against
//     those amps would move.
//
// Until the divider is deliberately re-fitted, treat outlet 5 as a monitor of
// whatever rail the INA226 is actually on and say so on the dashboard.
#define INA226_ADDR 0x40
// Bus-voltage divider ratio, calibrated on the bench. The INA226 reports 24.1 V
// at its bus pin; mains measured 228 V with a multimeter, so 228 / 24.1 = 9.46.
// Re-check with a multimeter after touching the resistor ladder and update this
// one number — it is the only calibration constant in the voltage path.
// DO NOT "fix" this to 1.0 to make the USB outlet read 5 V without doing the
// mains re-calibration above; that single edit would make every CH1-4 watt in
// the telemetry wrong by 9.46x.
#define INA226_MAIN_VOLT_DIVIDER 9.46f

// Shunt calibration, exactly as the validated bench sketch sets it: 8 A full
// scale on a 10 mOhm shunt. The INA226 derives current from the shunt voltage,
// so the wrong shunt value scales EVERY current and watt reading - this was
// reporting 0 A and 0 W while the sensor itself was fine.
#define INA226_MAX_CURRENT_AMPS 8.0f
#define INA226_SHUNT_OHM 0.010f
// Used only when the INA226 is not answering at all, so the rig still reports a
// plausible voltage instead of reading 0 V on every channel.
#define FALLBACK_MAINS_VOLTS 228.0f

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
//   - the mains volts the run saw (it comes from the INA226, not an assumption),
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
#define ZMCT_CAL_FACTOR 0.52f

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
// So the window is halved to 250 samples (~235 ms/channel, ~14 AC cycles at
// 60 Hz - still a long enough window for an RMS to mean something) and the sweep
// period below is doubled, which keeps the pass at ~940 ms against a 2 s
// period: under the METER_INTERVAL_MS/2 guard, so the watchdog path never
// engages on a healthy rig.
//
// The visible consequence of the 2 s period: branchAmps only refreshes every 2 s
// while telemetry posts every 1 s, so the dashboard can show one repeated amps
// frame between updates. That is a stale-but-true number, which is the honest
// trade - the alternative is a sweep that overruns its own period and stops
// posting altogether.
#define ZMCT_DEDICATED_SAMPLES 250
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
// now ~235 ms (ZMCT_DEDICATED_SAMPLES), i.e. ~940 ms for all four. The RMS
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

// How often the INA226 is read. It is a VOLTAGE REFERENCE (see above), not a
// power meter, so it does not need a fast sample rate: the mains voltage it
// reports changes on the order of seconds, not milliseconds. Polling it on a
// fixed interval rather than on every loop() iteration keeps a core-1 pass from
// grabbing the I2C lock repeatedly (loop() runs thousands of times a second).
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
//   GPIO 4, 5, 6 clear ALL of the above. They are ordinary GPIOs on the
//   ESP32-S3 (not strapping, not ADC-only, not in the octal-PSRAM pin set,
//   which the N16R8 module uses at 26-32 and 35-37), so nothing else on this
//   board claims them.
//
// GPIO 1 CHECKED, NOT ASSUMED (2026-10-15): on the ESP32-S3 the strapping pins
// are 0, 3, 45 and 46 only. GPIO 1 is an ordinary GPIO (ADC1_CH0), is not in
// the USB-JTAG pair (19/20), is not a PSRAM pin on the N16R8 module, and is not
// touched by the boot loader on this board. There is NO conflict, so the wiring
// stays {2, 1} - do not remap it on suspicion. It is still worth knowing that
// it is an ADC1 pin, so it cannot be sampled by ADC2 while ADC1 is busy; that
// does not affect a digital output.
//
// VERIFY BEFORE POWERING: GPIO 4/5/6 were chosen from the exclusion banks above,
// which is a correct-by-construction argument but NOT an observation of the
// physical board. Until a relay is heard clicking on CH3 and CH4, actuation on
// those two channels is UNVERIFIED: the firmware will drive the pins and report
// pin=HIGH/LOW honestly either way, but only a meter across the contact (or the
// CH3/CH4 CT current going to zero on a disconnect) proves a relay is really
// attached to that pin. If the board headers are wired differently, change this
// table and the RELAY_PIN_n aliases together - the static_asserts below exist
// precisely because those two descriptions of the same wiring are the easiest
// pair in this file to edit and forget the other one of.
//
// VOLTAGE: the ESP32-S3 drives 3.3 V. A 5 V relay module with a 4N35/PC817
// input still pulls its coil in at 3.3 V (the opto LED threshold is ~1.2-1.4 V),
// but a module whose series resistor was sized for 5 V delivers noticeably less
// coil current and can buzz or fail to latch. If a relay does not audibly
// click, put a transistor or level shifter in front of it - or power the opto
// from VCC with the ESP32 side pulled low - rather than raising the ESP32 pin,
// which is not possible at 3.3 V anyway.
static constexpr uint8_t RELAY_PINS[OUTLET_COUNT] = { 2, 1, 4, 5, 6 };
// Named single-outlet aliases, because the wiring order (board header) and the
// channel order (dashboard CH1 first) are not the same thing and a bare
// RELAY_PINS[i] index hides that. RELAY_PIN_1 -> CH1, ..., RELAY_PIN_5 -> CH5.
#define RELAY_PIN_1 2
#define RELAY_PIN_2 1
#define RELAY_PIN_3 4
#define RELAY_PIN_4 5
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
// = 0 the device drove GPIO2 LOW on a Disconnect and the CH1 CT reading went to
// 0.000 A / 0.0 W (the load really was cut), and back to ~0.22 A / 51 W when
// GPIO2 went HIGH again. So this board IS high-true, and the flag above stays 0.
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
