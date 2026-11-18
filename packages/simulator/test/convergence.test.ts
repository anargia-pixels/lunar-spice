import { describe, expect, test } from "bun:test";

import { Circuit } from "../src/circuit";
import { Simulation } from "../src/simulation";

/**
 * An LM393 relaxation oscillator driving a MOSFET's gate, as a user built it. The output
 * swings 0 to 7 V; R5 and R6 (1 kΩ each, to 4.5 V) set thresholds of 2.25 V and 5.75 V on
 * the + input, and C1 (100 nF) charges through RV1 (1 kΩ) on the − input:
 *
 *   rising:  RC × ln((7 − 2.25) / (7 − 5.75)) = 133.5 µs
 *   falling: RC × ln(5.75 / 2.25)             =  93.8 µs
 *
 * a period of 227.3 µs, 4.40 kHz. Each flip snaps over through positive feedback in a few
 * nanoseconds, far shorter than the steps.
 */
const OSCILLATOR = [
  "w -496 176 -496 256 0",
  "c -864 272 -864 336 65536 1e-7 5.7 0",
  "w -864 272 -864 256 0",
  "w -864 256 -864 176 0",
  "w -864 176 -688 176 0",
  "w -864 336 -864 432 0",
  "g -864 432 -864 448 0 0",
  "w -768 256 -864 256 0",
  "w -560 256 -496 256 0",
  "w -496 176 -624 176 0",
  String.raw`a -656 256 -560 256 65536 7 0 120000000 LM393\s(±15\sV) 200000 120000000 17 0 37.5 0.002 7 0`,
  "r -672 336 -608 336 0 1000",
  "w -608 336 -496 336 0",
  "w -496 336 -496 256 0",
  "w -656 272 -704 272 0",
  "w -704 272 -704 336 0",
  "w -704 336 -672 336 0",
  "r -704 368 -704 432 0 1000",
  "w -704 368 -704 336 0",
  "w -768 256 -768 240 0",
  "w -768 240 -656 240 0",
  "R -704 432 -704 464 65536 0 40 4.5 0 0 0.5 0",
  "w -384 256 -496 256 0",
  String.raw`f -384 256 -352 256 65536 1.5 0.02 Generic\sN-channel 1.5 0.02 0 0 0 0`,
  "c -352 368 -352 432 65536 1e-8 0 0",
  "w -352 368 -352 272 0",
  "g -352 432 -352 448 0 0",
  "r -688 176 -624 176 0 1000",
].join("\n");

/** Steps the oscillator for 5 ms; returns its frequency from the comparator's rising edges. */
function oscillate(timeStep: number) {
  const circuit = Circuit.parse(OSCILLATOR);
  const simulation = new Simulation(circuit.elements, "transient", timeStep);
  const comparator = circuit.elements.find(({ kind }) => kind === "op-amp");
  const rises: number[] = [];
  let isHigh = false;

  for (let step = 0; step < Math.round(5e-3 / timeStep); step += 1) {
    if (!simulation.step()) {
      throw new Error(simulation.error ?? "The step failed.");
    }

    const isNowHigh = (comparator?.volts[2] ?? 0) > 3.5;

    if (isNowHigh && !isHigh) {
      rises.push(simulation.time);
    }

    isHigh = isNowHigh;
  }

  const first = rises[1] ?? 0;
  const last = rises[rises.length - 1] ?? 0;

  return (rises.length - 2) / (last - first);
}

describe("convergence", () => {
  test("a comparator with hysteresis snaps over in steps far longer than its flip", () => {
    // Within 3 % of 4.40 kHz: the output's 37.5 Ω and 2 mV offset are left out above.
    expect(Math.abs(oscillate(1e-5) / 4400 - 1)).toBeLessThan(0.03);
    // Steps of 25 µs, a ninth of a period, run through every flip.
    expect(() => oscillate(2.5e-5)).not.toThrow();
  });

  test("steps of 1 µs and 10 µs time the oscillator alike", () => {
    // Each flip lands on its breakpoint whatever the step, so both agree within 0.2 %.
    expect(Math.abs(oscillate(1e-5) / oscillate(1e-6) - 1)).toBeLessThan(0.002);
  });

  test("a comparator far faster than the steps flips over in one", () => {
    const circuit = Circuit.parse(OSCILLATOR);
    const capacitor = circuit.elements.find(({ kind }) => kind === "capacitor");
    let steps = 0;

    if (capacitor) {
      const finishStep = capacitor.finishStep.bind(capacitor);

      capacitor.finishStep = (system) => {
        steps += 1;
        finishStep(system);
      };
    }

    const simulation = new Simulation(circuit.elements, "transient", 2.5e-5);

    for (let step = 0; step < 200; step += 1) {
      simulation.step();
    }

    // 5 ms at 4.40 kHz is 22 periods, 44 flips. The LM393 swings 7 V at 17 V/µs, about
    // 0.47 µs with its snap, under a thirty-second of a 25 µs step: each flip takes the steps
    // that land near its release and one more, not ten through the snap and the slew.
    expect((steps - 200) / 44).toBeLessThan(6);
    expect(Math.abs(oscillate(2.5e-5) / 4400 - 1)).toBeLessThan(0.03);
  });

  test("divided steps leave no sliver of a step to rounding", () => {
    const circuit = Circuit.parse(OSCILLATOR);
    const capacitor = circuit.elements.find(({ kind }) => kind === "capacitor");
    let shortest = Number.POSITIVE_INFINITY;

    if (capacitor) {
      const finishStep = capacitor.finishStep.bind(capacitor);

      capacitor.finishStep = (system) => {
        shortest = Math.min(shortest, system.timeStep);
        finishStep(system);
      };
    }

    // 100 ns is no binary fraction of a second, so the shorter steps it divides into
    // need not add up to it exactly.
    const simulation = new Simulation(circuit.elements, "transient", 1e-7);

    for (let step = 0; step < 20_000; step += 1) {
      simulation.step();
    }

    // A step under 1 ps stamps companion conductances too large to solve.
    expect(shortest).toBeGreaterThanOrEqual(1e-12);
  });
});
