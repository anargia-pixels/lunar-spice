import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  Circuit,
  readElementLine,
  settingsForTimeStep,
} from "@lunar-spice/simulator/circuit";
import { Simulation } from "@lunar-spice/simulator/simulation";

import { mergeState } from "../src/components/circuit-editor/element-state";
import { RunEngine } from "../src/components/circuit-editor/run-engine";
import type { LoadedElement } from "../src/components/circuit-editor/run-protocol";

/** 5 V through 1 kΩ charging 1 µF: a 1 ms time constant. */
const RC_LINES = [
  "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
  "r 0 0 64 0 0 1000",
  "c 64 0 64 64 0 0.000001 0",
  "g 64 64 64 80 0 0",
];

/** 1× real time in 1 µs steps: a million steps a second. */
const SETTINGS = {
  ...Circuit.parse("").settings,
  ...settingsForTimeStep(1, 1e-6),
};

function loaded(lines: readonly string[], instances?: readonly number[]) {
  return lines.map((line, index): LoadedElement => ({
    line,
    id: index + 1,
    instance: instances?.[index] ?? index + 1,
    isPressed: false,
  }));
}

/** Steps `engine` through `steps` steps of 1 µs, however long they take. */
function stepFor(engine: RunEngine, steps: number) {
  engine.setRunning(true);
  engine.run(0, Number.POSITIVE_INFINITY);

  // Real time of exactly `steps` microseconds, less than the catch-up cap per call.
  for (let done = 0; done < steps; done += 50_000) {
    engine.run(Math.min(steps, done + 50_000) / 1000, Number.POSITIVE_INFINITY);
  }
}

/** The capacitor's voltage in a snapshot, read off its patched state. */
function capacitorVoltage(engine: RunEngine) {
  const element = readElementLine(RC_LINES[2] ?? "");
  const patch = engine.snapshot().states[2]?.[1];

  if (!element || !patch) {
    throw new Error("No capacitor.");
  }

  mergeState(element, patch);

  return element.voltageDifference();
}

/**
 * Makes `performance.now` read `clock()` until the test ends, so it sets when a slice's
 * budget runs out and how long the behind warning stays lit.
 */
function mockClock(clock: () => number) {
  spyOn(performance, "now").mockImplementation(clock);
}

describe("run engine", () => {
  afterEach(() => {
    mock.restore();
  });

  test("steps as a simulation of the same circuit does", () => {
    const engine = new RunEngine();

    engine.load(1, loaded(RC_LINES), SETTINGS, true);
    stepFor(engine, 1000);

    const circuit = Circuit.parse(RC_LINES.join("\n"));
    const simulation = new Simulation(circuit.elements, "transient", 1e-6);

    for (let step = 0; step < 1000; step += 1) {
      simulation.step();
    }

    const snapshot = engine.snapshot();

    expect(snapshot.time).toBeCloseTo(1e-3, 12);
    expect(snapshot.voltages).toEqual(
      simulation.system.solution.slice(0, simulation.netlist.nodeCount),
    );
    // 5 V × (1 − 1/e) after one time constant.
    expect(capacitorVoltage(engine)).toBeCloseTo(5 * (1 - Math.exp(-1)), 2);
  });

  test("keeps a moved capacitor's charge, and Reset clears it", () => {
    const engine = new RunEngine();

    engine.load(1, loaded(RC_LINES), SETTINGS, true);
    stepFor(engine, 1000);

    const charged = capacitorVoltage(engine);

    // The whole circuit moved 16 to the right: every line changes, every object stays.
    const moved = RC_LINES.map((line) =>
      line
        .split(" ")
        .map((token, index) =>
          index === 1 || index === 3 ? String(Number(token) + 16) : token,
        )
        .join(" "),
    );

    engine.load(2, loaded(moved), SETTINGS, false);
    expect(capacitorVoltage(engine)).toBeCloseTo(charged, 12);

    // A new object in the editor, as an edited copy is, starts afresh.
    engine.load(3, loaded(moved, [1, 2, 99, 4]), SETTINGS, false);
    expect(capacitorVoltage(engine)).toBe(0);

    stepFor(engine, 1000);
    engine.load(4, loaded(moved, [1, 2, 99, 4]), SETTINGS, true);
    expect(capacitorVoltage(engine)).toBe(0);
    expect(engine.snapshot().time).toBe(0);
  });

  test("holds a push switch down while it is pressed", () => {
    const lines = [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      "s 0 0 64 0 0 1 true",
      "r 64 0 64 64 0 1000",
      "g 64 64 64 80 0 0",
    ];

    const engine = new RunEngine();

    const pressed = loaded(lines).map((element) =>
      element.id === 2 ? { ...element, isPressed: true } : element,
    );

    engine.load(1, pressed, SETTINGS, true);
    stepFor(engine, 10);

    const resistor = readElementLine(lines[2] ?? "");
    const patch = engine.snapshot().states[2]?.[1];

    if (!resistor || !patch) {
      throw new Error("No resistor.");
    }

    mergeState(resistor, patch);
    expect(Math.abs(resistor.current)).toBeCloseTo(0.005, 9);
  });

  test("leaves the steps a slice has no time for to the next", () => {
    // The clock reads past every deadline, so each slice stops at its first look.
    let clock = 0;

    mockClock(() => clock + 1);

    const engine = new RunEngine();

    engine.load(1, loaded(RC_LINES), SETTINGS, true);
    engine.setRunning(true);
    engine.run(0, 0);

    // 1 ms of real time is 1000 steps, of which a slice without budget takes few.
    clock = 1;
    expect(engine.run(1, 0)).toBe(true);
    expect(engine.snapshot().time).toBeLessThan(1e-4);

    // A slice with time for them catches up, and nothing was dropped.
    expect(engine.run(1, Number.POSITIVE_INFINITY)).toBe(false);

    const snapshot = engine.snapshot();

    expect(snapshot.time).toBeCloseTo(1e-3, 12);
    expect(snapshot.isBehind).toBe(false);
  });

  test("drops the steps it owes past 100 ms, and says it is behind", () => {
    let clock = 0;

    mockClock(() => clock + 1);

    const engine = new RunEngine();

    engine.load(1, loaded(RC_LINES), SETTINGS, true);
    engine.setRunning(true);
    engine.run(0, 0);

    // Each 50 ms owes 50,000 more steps than the slice takes.
    for (clock = 50; clock <= 300; clock += 50) {
      engine.run(clock, 0);
    }

    clock = 300;
    engine.run(clock, Number.POSITIVE_INFINITY);

    const snapshot = engine.snapshot();

    // The last 100 ms were made up for; what was owed before them was dropped.
    expect(snapshot.time).toBeGreaterThan(0.1);
    expect(snapshot.time).toBeLessThan(0.11);
    expect(snapshot.isBehind).toBe(true);
  });

  test("gives the editor's copies the worker's state", () => {
    const engine = new RunEngine();

    engine.load(1, loaded(RC_LINES), SETTINGS, true);
    stepFor(engine, 500);

    const editor = Circuit.parse(RC_LINES.join("\n")).elements;
    const snapshot = engine.snapshot();

    for (const [id, patch] of snapshot.states) {
      const element = editor[id - 1];

      if (element) {
        mergeState(element, patch);
      }
    }

    const reference = Circuit.parse(RC_LINES.join("\n"));
    const simulation = new Simulation(reference.elements, "transient", 1e-6);

    for (let step = 0; step < 500; step += 1) {
      simulation.step();
    }

    editor.forEach((element, index) => {
      const expected = reference.elements[index];

      expect(element.current).toBeCloseTo(expected?.current ?? Number.NaN, 12);
      expect(element.volts).toEqual(expected?.volts ?? []);
      expect(element.info()).toEqual(expected?.info() ?? []);
    });
  });
});
