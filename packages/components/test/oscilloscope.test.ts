import { describe, expect, test } from "bun:test";

import { Circuit, settingsForTimeStep } from "@lunar-spice/simulator/circuit";
import {
  AC_COUPLING_CORNER,
  type Coupling,
  defaultOscilloscopeSettings,
  Oscilloscope,
  type OscilloscopeSettings,
} from "@lunar-spice/simulator/elements/oscilloscope";

import { RunEngine } from "../src/components/circuit-editor/run-engine";
import {
  autoset,
  measureChannel,
  OscilloscopeRecorder,
  valueAt,
  type OscilloscopeTrace,
} from "../src/lib/oscilloscope";

const TIME_STEP = 1e-6;

/** CH1: 1 kHz, 1 V sine on 0.5 V. CH2: 1 kHz, 0 to 5 V square, high a quarter of the time. */
function signals(time: number) {
  return [
    0.5 + Math.sin(2 * Math.PI * 1000 * time),
    (time * 1000) % 1 < 0.25 ? 5 : 0,
    0,
    0,
    0,
  ];
}

/** CH1 and CH2 on at 1 V/div, 200 µs/div, triggering where CH1 rises through 0.5 V. */
function settingsWith(
  changes: Partial<OscilloscopeSettings> = {},
): OscilloscopeSettings {
  return {
    ...defaultOscilloscopeSettings(),
    secondsPerDivision: 2e-4,
    triggerLevel: 0.5,
    ...changes,
  };
}

/** `settingsWith(changes)` with CH1 and CH2 coupled as given. */
function withCouplings(
  first: Coupling,
  second: Coupling,
  changes: Partial<OscilloscopeSettings> = {},
) {
  const settings = settingsWith(changes);
  const couplings = [first, second];

  return {
    ...settings,
    channels: settings.channels.map((channel, index) => ({
      ...channel,
      coupling: couplings[index] ?? channel.coupling,
    })),
  };
}

/** Records `seconds` of `signals` and returns the recorder with its latest triggered trace. */
function record(settings: OscilloscopeSettings, seconds: number) {
  const recorder = new OscilloscopeRecorder(1, settings, TIME_STEP);
  const oscilloscope = new Oscilloscope(0, 0, 0, 0);
  let triggered: OscilloscopeTrace | null = null;

  for (let step = 1; step <= Math.round(seconds / TIME_STEP); step += 1) {
    const time = step * TIME_STEP;

    oscilloscope.volts = signals(time);
    recorder.record(oscilloscope, time);

    // A snapshot every 1000 steps, as frames take traces and arm the trigger again.
    if (step % 1000 === 0) {
      triggered = recorder.takeTriggered() ?? triggered;
    }
  }

  return { recorder, triggered };
}

describe("oscilloscope recorder", () => {
  test("triggers where the source crosses the level between steps", () => {
    const { triggered } = record(settingsWith(), 0.01);
    const triggerTime = triggered?.triggerTime ?? 0;

    // The sine rises through 0.5 V on every whole millisecond.
    expect(triggerTime).toBeCloseTo(Math.round(triggerTime * 1000) / 1000, 10);
    // The trigger sits in the middle of the 2 ms screen.
    expect(triggered?.start).toBeCloseTo(triggerTime - 1e-3, 12);
    expect(triggered?.end).toBeCloseTo(triggerTime + 1e-3, 12);
  });

  test("reads a channel's value between its buckets", () => {
    const { triggered } = record(settingsWith(), 0.01);
    const triggerTime = triggered?.triggerTime ?? 0;

    // CH1 is 0.5 V on the trigger and a cycle either side of it, 1.5 V a quarter on.
    for (const offset of [-1e-3, 0, 1e-3]) {
      expect(
        triggered ? valueAt(triggered, 0, triggerTime + offset) : null,
      ).toBeCloseTo(0.5, 3);
    }

    expect(
      triggered ? valueAt(triggered, 0, triggerTime + 2.5e-4) : null,
    ).toBeCloseTo(1.5, 3);
  });

  test("puts the trigger where the horizontal position says", () => {
    // Two divisions right of the middle: seven of the ten divisions before it.
    const { triggered } = record(settingsWith({ position: 2 }), 0.01);
    const triggerTime = triggered?.triggerTime ?? 0;

    expect(triggered?.start).toBeCloseTo(triggerTime - 1.4e-3, 12);
  });

  test("triggers on a falling edge", () => {
    const { triggered } = record(
      settingsWith({ triggerEdge: "falling" }),
      0.01,
    );

    const triggerTime = triggered?.triggerTime ?? 0;

    // It falls through 0.5 V half a millisecond after each rise.
    expect((triggerTime * 1000) % 1).toBeCloseTo(0.5, 6);
  });

  test("measures a sine over the screen", () => {
    const { triggered } = record(settingsWith(), 0.01);
    const readings = triggered && measureChannel(triggered, 0);

    // Two whole cycles on the screen: the mean is the 0.5 V offset, the RMS
    // √(0.5² + 1² / 2) = 0.866 V.
    expect(readings?.frequency ?? 0).toBeCloseTo(1000, 0);
    expect(readings?.period ?? 0).toBeCloseTo(1e-3, 6);
    expect(readings?.["peak-to-peak"] ?? 0).toBeCloseTo(2, 3);
    expect(readings?.maximum ?? 0).toBeCloseTo(1.5, 3);
    expect(readings?.minimum ?? 0).toBeCloseTo(-0.5, 3);
    expect(readings?.mean ?? 0).toBeCloseTo(0.5, 3);
    expect(readings?.rms ?? 0).toBeCloseTo(Math.sqrt(0.75), 3);
    expect(readings?.duty ?? 0).toBeCloseTo(0.5, 2);
  });

  test("measures a square wave's duty cycle", () => {
    const { triggered } = record(settingsWith(), 0.01);
    const readings = triggered && measureChannel(triggered, 1);

    // High 250 µs of each 1 ms: 25 %, a mean of 1.25 V and an RMS of √(25 × 0.25) V.
    expect(readings?.duty ?? 0).toBeCloseTo(0.25, 2);
    expect(readings?.frequency ?? 0).toBeCloseTo(1000, 0);
    expect(readings?.mean ?? 0).toBeCloseTo(1.25, 2);
    expect(readings?.rms ?? 0).toBeCloseTo(2.5, 2);
  });

  test("shows the latest screen untriggered", () => {
    const { recorder } = record(settingsWith(), 0.01);
    const live = recorder.live();

    expect(live?.triggerTime).toBeNull();
    expect(live?.end ?? 0).toBeCloseTo(0.01, 9);
    expect(live?.start ?? 0).toBeCloseTo(0.008, 9);
  });

  test("AC coupling blocks a channel's offset", () => {
    const { triggered } = record(withCouplings("ac", "dc"), 0.2);
    const readings = triggered && measureChannel(triggered, 0);

    // 1 kHz is a hundred times the 10 Hz corner: the sine passes whole about 0 V.
    expect(readings?.mean ?? 1).toBeCloseTo(0, 2);
    expect(readings?.["peak-to-peak"] ?? 0).toBeCloseTo(2, 2);
  });

  test("AC coupling decays a step with the corner's time constant", () => {
    // 10 µs/div puts one 1 µs step in each bucket, so the last bucket is the last step.
    const settings = withCouplings("ac", "dc", { secondsPerDivision: 1e-5 });
    const recorder = new OscilloscopeRecorder(1, settings, TIME_STEP);
    const oscilloscope = new Oscilloscope(0, 0, 0, 0);
    const timeConstant = 1 / (2 * Math.PI * AC_COUPLING_CORNER);
    const steps = Math.round(timeConstant / TIME_STEP);

    oscilloscope.volts = [0, 0, 0, 0, 0];
    recorder.record(oscilloscope, TIME_STEP);
    oscilloscope.volts = [1, 0, 0, 0, 0];

    for (let step = 1; step <= steps; step += 1) {
      recorder.record(oscilloscope, (step + 1) * TIME_STEP);
    }

    const live = recorder.live();
    const last = live?.channels[0]?.extremes.at(-1);

    // A 1 V step through a high-pass reads e^(−t/τ): 1/e one time constant on.
    expect(last ?? 0).toBeCloseTo(Math.exp(-1), 3);
  });

  test("GND coupling shows a flat 0 V that autoset leaves alone", () => {
    const settings = withCouplings("dc", "gnd");
    const { recorder, triggered } = record(settings, 0.01);
    const readings = triggered && measureChannel(triggered, 1);

    expect(readings?.maximum).toBe(0);
    expect(readings?.minimum).toBe(0);
    expect(autoset(settings, recorder.meters)?.channels[1]).toEqual(
      settings.channels[1],
    );
  });

  test("autoset scales the channels and triggers on the first repeating one", () => {
    const { recorder } = record(settingsWith({ secondsPerDivision: 1 }), 0.05);
    const settings = autoset(settingsWith(), recorder.meters);

    // 2 V peak-to-peak over six divisions needs 0.5 V/div; its middle, 0.5 V, one
    // division down. 5 V needs 1 V/div, its middle 2.5 divisions down.
    expect(settings?.channels).toEqual([
      { isOn: true, coupling: "dc", voltsPerDivision: 0.5, position: -1 },
      { isOn: true, coupling: "dc", voltsPerDivision: 1, position: -2.5 },
      { isOn: false, coupling: "dc", voltsPerDivision: 1, position: 0 },
      { isOn: false, coupling: "dc", voltsPerDivision: 1, position: 0 },
    ]);
    expect(settings?.triggerSource).toBe(0);
    expect(settings?.triggerLevel ?? 0).toBeCloseTo(0.5, 3);
    // Two and a half cycles of 1 kHz is 250 µs a division, rounded up to 500 µs.
    expect(settings?.secondsPerDivision).toBe(5e-4);
  });

  test("records a wired oscilloscope in the run engine", () => {
    // 5 V through 1 kΩ charging 1 µF, CH1 on the capacitor and COM on ground.
    const lines = [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      "r 0 0 64 0 0 1000",
      "c 64 0 64 64 0 0.000001 0",
      "g 64 64 64 80 0 0",
      "LSOSC 200 0 328 128 65536",
      "w 64 0 184 16 0",
      "w 64 64 264 144 0",
    ];

    const engine = new RunEngine();

    engine.load(
      1,
      lines.map((line, index) => ({
        line,
        id: index + 1,
        instance: index + 1,
        isPressed: false,
      })),
      { ...Circuit.parse("").settings, ...settingsForTimeStep(1, 1e-6) },
      true,
    );
    engine.setOscilloscopes([{ elementId: 5, settings: settingsWith() }]);
    engine.setRunning(true);
    engine.run(0, Number.POSITIVE_INFINITY);
    // 1 ms of real time at 1× in 1 µs steps.
    engine.run(1, Number.POSITIVE_INFINITY);

    const [data] = engine.snapshot().oscilloscopes;
    const live = data?.live;
    const extremes = live?.channels[0]?.extremes;

    // At 1 ms, one time constant, it has charged to 5 × (1 − 1/e) = 3.16 V. The
    // trapezoidal rule's first step charges it half as much, so it runs half a step,
    // 0.9 mV, behind.
    expect(live?.end ?? 0).toBeCloseTo(1e-3, 9);
    expect(
      Math.abs((extremes?.at(-1) ?? 0) - 5 * (1 - Math.exp(-1))),
    ).toBeLessThan(0.002);
  });
});
