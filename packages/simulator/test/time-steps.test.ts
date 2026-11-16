import { describe, expect, test } from "bun:test";

import { Circuit } from "../src/circuit";
import { CompanionCapacitor } from "../src/companion";
import { MnaSystem } from "../src/mna-system";
import { Simulation } from "../src/simulation";

/**
 * An LM393 held at its 7 V limit while 100 µA charges 1 µF on its − input, so the input
 * difference d = 1 V − v(C) + 2 mV offset falls at 100 V/s. The limiter lets go where the
 * stage pushes just 7 A into the pole node's 1 Ω: Imax × tanh(gain × d / Imax) = 7 A, with
 * Imax = slew × C = 17 V/µs × 200000 / (2π × 120 MHz) = 4509 A, at
 *
 *   d = (4509 A / 200000) × atanh(7 / 4509) = 35.0 µV.
 *
 * Past it the stage is linear, and the pole node, τ = 200000 / (2π × 120 MHz) = 265.3 µs,
 * falls s seconds later to v(s) = 7 − k × s + k × τ × (1 − e^(−s/τ)), k = 200000 × 100 V/s.
 * The capacitor starts with no current, so the trapezoidal rule's first step charges it
 * half as much: the ramp runs half a step late, and the tests read d off the run.
 */
const RELEASE = [
  String.raw`a 64 16 160 16 65536 7 0 120000000 LM393\s(±15\sV) 200000 120000000 17 0 37.5 0.002 7 0`,
  "R 64 32 32 32 0 0 40 1 0 0 0.5",
  "i 64 -64 64 0 0 0.0001",
  "g 64 -64 64 -96 0 0",
  "c 64 0 0 0 0 1e-6 0",
  "g 0 0 0 32 0 0",
].join("\n");

const RELEASE_DIFFERENCE = 35.0e-6;

/** How fast the input difference falls, in volts per second. */
const RAMP = 100;

/** The comparator's output `s` seconds after its limiter lets go. */
function fallenOutput(s: number) {
  const tau = 200000 / (2 * Math.PI * 120e6);
  const k = 200000 * 100;

  return 7 - k * s + k * tau * (1 - Math.exp(-s / tau));
}

/** The op-amp's input difference with its offset, from its latest voltages. */
function inputDifference(opAmp: { volts: number[] }) {
  return (opAmp.volts[1] ?? 0) - (opAmp.volts[0] ?? 0) + 0.002;
}

/**
 * Steps the release circuit to 10 ms, still held, then to `stopTime`. Returns its op-amp
 * and when the limiter lets go, from the input difference at 10 ms.
 */
function release(timeStep: number, stopTime: number) {
  const circuit = Circuit.parse(RELEASE);
  const simulation = new Simulation(circuit.elements, "transient", timeStep);
  const opAmp = circuit.elements.find(({ kind }) => kind === "op-amp");

  if (!opAmp) {
    throw new Error("The circuit has no op-amp.");
  }

  const stepTo = (time: number) => {
    while (simulation.time < time - timeStep / 2) {
      if (!simulation.step()) {
        throw new Error(simulation.error ?? "The step failed.");
      }
    }
  };

  stepTo(0.01);

  const releaseTime =
    simulation.time + (inputDifference(opAmp) - RELEASE_DIFFERENCE) / RAMP;

  stepTo(stopTime);

  return { opAmp, releaseTime };
}

describe("time steps", () => {
  test("an op-amp predicts when its limiter lets go", () => {
    const { opAmp } = release(1e-5, 0.01);
    const difference = inputDifference(opAmp);

    // A few millivolts short of letting go.
    expect(difference).toBeGreaterThan(0.001);
    expect(difference).toBeLessThan(0.005);
    // Within 0.5 ns, a hundredth of the 350 ns the 35 µV moves it.
    expect(opAmp.timeToBreakpoint()).toBeCloseTo(
      (difference - RELEASE_DIFFERENCE) / RAMP,
      9,
    );
  });

  test("steps of any length follow the output from the release", () => {
    // Letting go at 0 V instead would leave the output 0.13 V higher 5 µs on.
    for (const timeStep of [1e-5, 1e-6, 2.5e-7]) {
      const { opAmp, releaseTime } = release(timeStep, 0.01003);
      const expected = fallenOutput(0.01003 - releaseTime);

      expect(Math.abs((opAmp.volts[2] ?? 0) - expected)).toBeLessThan(0.01);
    }
  });

  test("a retimed system stamps what a new one for that step would", () => {
    const build = (timeStep: number) => {
      const system = new MnaSystem(3, 0, "transient", timeStep);

      system.beginBase();
      system.stampResistor(1, 2, 1000);
      system.stampCapacitance(1, 0, 1e-6);
      system.stampInductance(2, 0, 1e-3);
      system.finishBase();

      return system;
    };

    const retimed = build(1e-6);

    retimed.retime(2.5e-7);
    expect([...retimed.base]).toEqual([...build(2.5e-7).base]);
  });

  test("a damped companion step is backward Euler", () => {
    const system = new MnaSystem(2, 0, "transient", 1e-6);
    const capacitor = new CompanionCapacitor(1e-6);

    capacitor.voltage = 1;
    // The trapezoidal rule would carry this current on; backward Euler drops it.
    capacitor.current = 5;
    capacitor.startStep(system, true);
    // C / h = 1 S beside the base's trapezoidal 2C / h = 2 S.
    expect(capacitor.extraConductance).toBeCloseTo(-1, 12);

    // i = C × (v − v0) / h = 1 µF × 2 V / 1 µs.
    capacitor.finish(system, 3);
    expect(capacitor.current).toBeCloseTo(2, 12);
  });
});
