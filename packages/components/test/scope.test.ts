import { describe, expect, test } from "bun:test";

import {
  createScope,
  orderedSamples,
  recordSample,
  triggerLevelOf,
  triggerRangeOf,
  updateScope,
} from "../src/lib/scope";

/**
 * A scope spanning 2 ms that has recorded 600 steps of 10 µs of a 1 kHz, 1 V sine: 100
 * steps a period, so one bucket a step. Sample `n` is sin(2π × (n + 0.5) / 100), which
 * rises through 0 V between samples 99 and 100 of every period.
 */
function sineScope() {
  const scope = createScope(1, "V(out)", 1e-5);

  updateScope(scope, { timeSpan: 2e-3 });

  for (let step = 0; step < 600; step += 1) {
    recordSample(scope, Math.sin((2 * Math.PI * (step + 0.5)) / 100), 0, 1e-5);
  }

  return scope;
}

describe("scope trigger", () => {
  test("starts the view where the voltage rises through the middle of the trace", () => {
    const scope = sineScope();
    const { values, times, timeRange } = orderedSamples(scope, "voltage");

    expect(triggerLevelOf(scope)).toBeCloseTo(0, 2);
    // The latest rise with 200 steps after it is at sample 400: sin(2π × 0.5 / 100).
    expect(values[0]).toBeCloseTo(0.0314, 4);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeCloseTo(1.99e-3, 9);
    expect(timeRange).toEqual({ min: 0, max: 2e-3 });
  });

  test("starts at the level the slider sets", () => {
    const scope = sineScope();

    updateScope(scope, { triggerLevel: 0.5 });

    // sin reaches 0.5 at 30°, so the first sample at or above it is 8: sin(2π × 8.5 / 100).
    expect(orderedSamples(scope, "voltage").values[0]).toBeCloseTo(0.509, 3);
  });

  test("scrolls when it is off, or when the voltage never reaches the level", () => {
    for (const settings of [{ isTriggered: false }, { triggerLevel: 2 }]) {
      const scope = sineScope();

      updateScope(scope, settings);

      const { values, times, timeRange } = orderedSamples(scope, "voltage");

      // The view ends on the latest sample, 599, at 0 s.
      expect(values[values.length - 1]).toBeCloseTo(
        Math.sin((2 * Math.PI * 599.5) / 100),
        6,
      );
      expect(times[times.length - 1]).toBe(0);
      expect(timeRange).toEqual({ min: -2e-3, max: 0 });
    }
  });

  test("spans the voltage scale, or else the peak rounded up to 1, 2 or 5", () => {
    const scope = sineScope();

    expect(triggerRangeOf(scope)).toBe(1);
    recordSample(scope, -12, 0, 1e-5);
    expect(triggerRangeOf(scope)).toBe(20);
    updateScope(scope, { voltageScale: 5 });
    expect(triggerRangeOf(scope)).toBe(5);
  });
});
