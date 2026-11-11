import { describe, expect, test } from "bun:test";

import { operatingPoint, transient } from "../src/analyses";
import { Circuit } from "../src/circuit";
import { SchmittTrigger } from "../src/elements/schmitt-trigger";

/** A circuit file from element lines, with the default settings line. */
function circuit(...lines: string[]) {
  return ["$ 1 0.000005 10.2 50 5 50", ...lines].join("\n");
}

/** The values of one trace of a transient from rest. */
function traceOf(text: string, name: string, stopTime: number, step: number) {
  const result = transient(text, {
    stopTime,
    startTime: 0,
    maxTimeStep: step,
    initialConditions: "zero",
  });

  const trace = result.traces.find((candidate) => candidate.name === name);

  if (!trace) {
    throw new Error(`No trace named ${name}`);
  }

  return { times: result.times, values: trace.values };
}

/** The times at which `values` rise through `level`. */
function risesThrough(
  times: readonly number[],
  values: readonly number[],
  level: number,
) {
  return times.filter(
    (_time, index) =>
      index > 0 &&
      (values[index - 1] ?? 0) < level &&
      (values[index] ?? 0) >= level,
  );
}

describe("Schmitt trigger", () => {
  /** A DC source of `volts` into a Schmitt trigger line, its output labeled `out`. */
  function driven(volts: number, trigger: string, load = "") {
    return circuit(
      `v 0 64 0 0 0 0 40 ${volts} 0 0 0.5`,
      "g 0 64 0 96 0 0",
      trigger,
      "207 64 0 64 -32 0 out",
      ...(load ? [load, "g 64 64 64 96 0 0"] : []),
    );
  }

  function out(text: string) {
    return (
      operatingPoint(text).nets.find(({ net }) => net === "out")?.voltage ??
      Number.NaN
    );
  }

  test("reads Falstad's buffer and inverter lines", () => {
    // Falstad's fields: slew rate in V/ns, lower and upper threshold, high and low level.
    const buffer = "182 0 0 64 0 0 0.5 1.66 3.33 5 0";
    const inverter = "183 0 0 64 0 0 0.5 1.66 3.33 5 0";

    expect(out(driven(4, buffer))).toBeCloseTo(5, 6);
    expect(out(driven(1, buffer))).toBeCloseTo(0, 6);
    expect(out(driven(4, inverter))).toBeCloseTo(0, 6);
    expect(out(driven(1, inverter))).toBeCloseTo(5, 6);
  });

  test("keeps Falstad's fields first when it writes a line", () => {
    const [element] = Circuit.parse(
      "183 0 0 64 0 0 0.5 1.66 3.33 5 0",
    ).elements;

    expect(element).toBeInstanceOf(SchmittTrigger);
    expect(element?.dump()).toStartWith(
      "183 0 0 64 0 65536 0.5 1.66 3.33 5 0 ",
    );
    expect(Circuit.parse(element?.dump() ?? "").elements[0]?.dump()).toBe(
      element?.dump(),
    );
  });

  test("holds its level between the thresholds", () => {
    // From rest the input state is low; 2.5 V sits between 1.66 V and 3.33 V.
    expect(out(driven(2.5, "182 0 0 64 0 0 0.5 1.66 3.33 5 0"))).toBeCloseTo(
      0,
      6,
    );
  });

  test("drops its output across the output resistance", () => {
    // A 74HC14 with its input low: 4.5 V behind 45 Ω into 1 kΩ.
    const text = driven(
      0,
      "183 0 0 64 0 65536 0.5 1.4 2.38 4.5 0 74HC14\\s(4.5\\sV) 2.38 1.4 4.5 0 45 500",
      "r 64 0 64 64 0 1000",
    );

    expect(out(text)).toBeCloseTo((4.5 * 1000) / 1045, 6);
  });

  test("oscillates with an RC at the period its thresholds set", () => {
    // 10 kΩ from the output back to the input, 100 nF from the input to ground. The
    // input ramps between 1.66 V and 3.33 V with 5 V and 0 V outputs:
    // T = RC × (ln((5 − 1.66) / (5 − 3.33)) + ln(3.33 / 1.66)) = 1.3893 ms.
    const text = circuit(
      "183 0 0 64 0 0 0 1.66 3.33 5 0",
      "w 64 0 64 -64 0",
      "r 64 -64 0 -64 0 10000",
      "w 0 -64 0 0 0",
      "c 0 0 0 64 0 1e-7 0",
      "g 0 64 0 96 0 0",
      "207 64 0 96 0 0 out",
    );

    const { times, values } = traceOf(text, "V(out)", 0.02, 1e-6);
    const rises = risesThrough(times, values, 2.5).slice(1);

    const period =
      ((rises[rises.length - 1] ?? 0) - (rises[0] ?? 0)) / (rises.length - 1);

    expect(rises.length).toBeGreaterThan(5);
    expect(period).toBeGreaterThan(1.3893e-3 * 0.99);
    expect(period).toBeLessThan(1.3893e-3 * 1.01);
  });
});

describe("op-amp relaxation oscillator", () => {
  // 5 V through 1 kΩ and 1 kΩ to ground bias the non-inverting input, 1 kΩ feeds the
  // output back to it, and the inverting input sits on 10 µF charged through 1 kΩ.
  const text = circuit(
    "v 0 192 0 96 0 0 40 5 0 0 0.5",
    "g 0 192 0 224 0 0",
    "r 0 96 192 96 0 1000",
    "r 192 96 192 192 0 1000",
    "g 192 192 192 224 0 0",
    "w 192 96 288 96 0",
    "207 192 96 192 64 0 plus",
    "a 288 80 384 80 65536 13 -13 1000000 LM741\\s(±15\\sV) 200000 1000000 0.5 2000000 75 0.001 13 -13",
    "w 288 64 288 0 0",
    "207 288 0 256 0 0 cap",
    "c 288 0 96 0 0 0.00001 0",
    "g 96 0 96 32 0 0",
    "r 288 0 384 0 0 1000",
    "w 384 0 384 80 0",
    "r 192 96 384 144 0 1000",
    "w 384 144 384 80 0",
    "207 384 80 432 80 0 out",
  );

  // The LM741 snaps over faster than these steps resolve, so each switch is solved in
  // smaller steps; before that the run stopped at the first one.
  for (const step of [5e-6, 5e-5]) {
    test(`switches at (5 V + Vout) / 3 with ${step * 1e6} µs steps`, () => {
      const output = traceOf(text, "V(out)", 0.1, step);
      const capacitor = traceOf(text, "V(cap)", 0.1, step).values;
      const high = Math.max(...output.values);
      const low = Math.min(...output.values);

      expect(
        risesThrough(output.times, output.values, 0).length,
      ).toBeGreaterThan(5);
      expect(high).toBeGreaterThan(11);
      expect(low).toBeLessThan(-11);
      expect(Math.max(...capacitor)).toBeCloseTo((5 + high) / 3, 1);
      expect(Math.min(...capacitor)).toBeCloseTo((5 + low) / 3, 1);
    });
  }
});
