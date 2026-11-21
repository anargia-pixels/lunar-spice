import { describe, expect, test } from "bun:test";

import { acSweep, operatingPoint, transient } from "../src/analyses";
import { Circuit } from "../src/circuit";
import { Optocoupler, Vactrol } from "../src/elements/optocouplers";

/** Thermal voltage the models use, in volts. */
const THERMAL_VOLTAGE = 0.025865;

/** A circuit file from element lines, with the default settings line. */
function circuit(...lines: string[]) {
  return ["$ 1 0.000005 10.2 50 5 50", ...lines].join("\n");
}

/** The voltage of the net labeled `name` at the operating point. */
function netVoltage(text: string, name: string) {
  return (
    operatingPoint(text).nets.find(({ net }) => net === name)?.voltage ??
    Number.NaN
  );
}

/** One trace of a transient. */
function traceOf(
  text: string,
  name: string,
  options: Parameters<typeof transient>[1],
) {
  const result = transient(text, options);
  const trace = result.traces.find((candidate) => candidate.name === name);

  if (!trace) {
    throw new Error(`No trace named ${name}`);
  }

  return { times: result.times, values: trace.values };
}

/** The first time `values` crosses `level`, interpolated between samples. */
function crossing(
  times: readonly number[],
  values: readonly number[],
  level: number,
) {
  for (let index = 1; index < values.length; index += 1) {
    const before = values[index - 1] ?? 0;
    const after = values[index] ?? 0;

    if ((before - level) * (after - level) <= 0 && before !== after) {
      const fraction = (level - before) / (after - before);
      const start = times[index - 1] ?? 0;

      return start + fraction * ((times[index] ?? 0) - start);
    }
  }

  return Number.NaN;
}

/** The part's line at the origin with `preset` picked: A, K left; outputs right. */
function partLine(part: Optocoupler | Vactrol, preset: string) {
  part.params.applyPreset(preset);

  return part.dump();
}

/**
 * A current source of `current` into the LED, A labeled `a`, K grounded; the parts sit
 * at the origin, so A is at (-16, 16) and K at (-16, 48).
 */
function ledDrive(current: number) {
  return [
    `i -16 48 -16 16 0 ${current}`,
    "g -16 48 -16 80 0",
    "207 -16 16 -48 16 0 a",
  ];
}

describe("Optocoupler", () => {
  /**
   * The LED driven with `current`; the collector, labeled `c`, pulled to `supply` through
   * `load` ohms, the emitter grounded.
   */
  function coupler(
    preset: string,
    current: number,
    supply: number,
    load: number,
  ) {
    return circuit(
      partLine(new Optocoupler(0, 0, 0, 0), preset),
      ...ledDrive(current),
      "g 80 48 80 80 0",
      `v 160 80 160 16 0 0 40 ${supply} 0 0 0.5`,
      "g 160 80 160 112 0",
      `r 160 16 80 16 0 ${load}`,
      "207 80 16 80 -16 0 c",
    );
  }

  test("keeps its line through a save", () => {
    const line = partLine(new Optocoupler(0, 0, 0, 0), "4N35");
    const [element] = Circuit.parse(line).elements;

    expect(element).toBeInstanceOf(Optocoupler);
    expect(element?.dump()).toBe(line);
  });

  test("drops its datasheet forward voltage", () => {
    // PC817: VF 1.2 V at 20 mA. 4N35: VF 1.3 V at 10 mA.
    expect(netVoltage(coupler("PC817", 0.02, 10, 100), "a")).toBeCloseTo(
      1.2,
      3,
    );
    expect(netVoltage(coupler("4N35", 0.01, 10, 100), "a")).toBeCloseTo(1.3, 3);
  });

  test("carries CTR × IF out of saturation", () => {
    // CTR 100 % at IF = 10 mA: IC = 10 mA, so the 100 Ω load drops 1 V from 10 V.
    expect(netVoltage(coupler("PC817", 0.01, 10, 100), "c")).toBeCloseTo(9, 4);
  });

  test("saturates at the datasheet's VCE(sat)", () => {
    // IF = 20 mA with 1 mA forced into the collector. The photocurrent into the base is
    // Ib = IF × CTR / (hFE + 1), and the transistor carries the rest: Ic = 1 mA − Ib.
    // Ebers–Moll in saturation, a = 1 + 1/BR:
    // VCE = VT × ln(Ic × (BF / BR + a) / (BF × Ib − Ic) + a) ≈ 0.1 V.
    const bf = 400;
    const br = 0.45;
    const base = (0.02 * 1) / (bf + 1);
    const collector = 1e-3 - base;
    const a = 1 + 1 / br;

    const expected =
      THERMAL_VOLTAGE *
      Math.log((collector * (bf / br + a)) / (bf * base - collector) + a);

    const text = circuit(
      partLine(new Optocoupler(0, 0, 0, 0), "PC817"),
      ...ledDrive(0.02),
      "g 80 48 80 80 0",
      "i 80 80 80 16 0 0.001",
      "g 80 80 80 112 0",
      "207 80 16 80 -16 0 c",
    );

    expect(expected).toBeCloseTo(0.1, 2);
    expect(netVoltage(text, "c")).toBeCloseTo(expected, 4);
  });

  test("rises from 10 % to 90 % in its rise time", () => {
    // PC817, tr = 4 µs: the collector current follows a first-order lag from rest.
    const { times, values } = traceOf(coupler("PC817", 0.01, 10, 100), "V(c)", {
      stopTime: 30e-6,
      // From the first step: the sample at 0 s is at rest, before the supply is on.
      startTime: 1e-8,
      maxTimeStep: 1e-8,
      initialConditions: "zero",
    });

    // The load drops 0 V dark and 1 V at full light.
    const rise = crossing(times, values, 9.1) - crossing(times, values, 9.9);

    expect(rise).toBeCloseTo(4e-6, 7);
  });

  test("rolls off 3 dB at 1 / (2π τ) in an AC sweep", () => {
    // The light lags with τ = tr / ln 9, so its pole sits at ln 9 / (2π × 4 µs).
    const pole = Math.log(9) / (2 * Math.PI * 4e-6);

    const text = circuit(
      partLine(new Optocoupler(0, 0, 0, 0), "PC817"),
      // 0.1 V of sine on 2 V of bias, through 50 Ω into the LED.
      "v -96 80 -96 16 0 1 1000 0.1 2 0 0.5",
      "g -96 80 -96 112 0",
      "r -96 16 -16 16 0 50",
      "g -16 48 -16 80 0",
      "g 80 48 80 80 0",
      "v 160 80 160 16 0 0 40 10 0 0 0.5",
      "g 160 80 160 112 0",
      "r 160 16 80 16 0 100",
      "207 80 16 80 -16 0 c",
    );

    const result = acSweep(text, {
      startFrequency: 10,
      stopFrequency: pole,
      scale: "linear",
      points: 2,
    });

    const [low = 0, atPole = 0] =
      result.nets.find(({ name }) => name === "V(c)")?.magnitude ?? [];

    expect(low).toBeGreaterThan(0);
    expect(atPole / low).toBeCloseTo(Math.SQRT1_2, 3);
  });
});

describe("Vactrol", () => {
  /**
   * The LED driven with `current`; 1 V across the cell in series with `load` ohms, the
   * point between them labeled `out`.
   */
  function vactrol(preset: string, current: number, load: number) {
    return circuit(
      partLine(new Vactrol(0, 0, 0, 0), preset),
      ...ledDrive(current),
      "v 160 80 160 16 0 0 40 1 0 0 0.5",
      "g 160 80 160 112 0",
      "w 160 16 80 16 0",
      `r 80 48 80 112 0 ${load}`,
      "g 80 112 80 144 0",
      "207 80 48 112 48 0 out",
    );
  }

  /** The cell's resistance from the divider's output. */
  function cellResistance(text: string, load: number) {
    const out = netVoltage(text, "out");

    return (load * (1 - out)) / out;
  }

  test("keeps its line through a save", () => {
    const line = partLine(new Vactrol(0, 0, 0, 0), "VTL5C4");
    const [element] = Circuit.parse(line).elements;

    expect(element).toBeInstanceOf(Vactrol);
    expect(element?.dump()).toBe(line);
  });

  test("matches the datasheet's resistances at 1, 10 and 40 mA", () => {
    // VTL5C3: 10 kΩ, 1 kΩ and 500 Ω, each in parallel with the 10 MΩ dark resistance.
    const parallel = (r: number) => 1 / (1 / r + 1 / 10e6);

    expect(cellResistance(vactrol("VTL5C3", 1e-3, 10_000), 10_000)).toBeCloseTo(
      parallel(10_000),
      1,
    );
    expect(cellResistance(vactrol("VTL5C3", 1e-2, 1000), 1000)).toBeCloseTo(
      parallel(1000),
      2,
    );
    expect(cellResistance(vactrol("VTL5C3", 4e-2, 500), 500)).toBeCloseTo(
      parallel(500),
      2,
    );
  });

  test("follows the curve's slope between and beyond the datasheet points", () => {
    // VTL5C3 below 10 mA: R ∝ IF^-1, so 0.5 mA gives 20 kΩ. Above it R ∝ IF^-0.5, so
    // 20 mA gives 1 kΩ / √2.
    const parallel = (r: number) => 1 / (1 / r + 1 / 10e6);

    expect(cellResistance(vactrol("VTL5C3", 5e-4, 20_000), 20_000)).toBeCloseTo(
      parallel(20_000),
      0,
    );
    expect(cellResistance(vactrol("VTL5C3", 2e-2, 707), 707)).toBeCloseTo(
      parallel(1000 / Math.SQRT2),
      2,
    );
  });

  test("is its dark resistance with the LED off", () => {
    expect(cellResistance(vactrol("VTL5C3", 0, 10e6), 10e6)).toBeCloseTo(
      10e6,
      -3,
    );
  });

  test("turns on with its turn-on time constant", () => {
    // VTL5C3 from dark with 10 mA: the light reaches 63.2 % of 10 mA at τ = 2.5 ms, where
    // the cell is 1 kΩ / 0.632 in parallel with 10 MΩ.
    const load = 1000;

    const { times, values } = traceOf(vactrol("VTL5C3", 0.01, load), "V(out)", {
      stopTime: 2.5e-3,
      startTime: 0,
      maxTimeStep: 1e-6,
      initialConditions: "zero",
    });

    const last = values[values.length - 1] ?? 0;
    const light = 1 - Math.exp(-1);
    const resistance = 1 / (light / 1000 + 1 / 10e6);

    expect(times[times.length - 1]).toBeCloseTo(2.5e-3, 9);
    expect(last).toBeCloseTo(load / (load + resistance), 3);
  });

  test("decays to 100 kΩ in its turn-off time", () => {
    // VTL5C3 at 10 mA until 0.5 s, then dark. 100 kΩ is a light of
    // 10 mA × (1 kΩ × (1 / 100 kΩ − 1 / 10 MΩ)) = 99 µA, so the light falls with
    // τ = 35 ms / ln(10 mA / 99 µA) and passes 99 µA 35 ms after the LED goes off.
    const load = 100e3;

    // A pulse at 1 Hz, high for its first half, set to the LED's forward voltage at
    // 10 mA, found from a 10 mA operating point: 10 mA through the LED, then 0.
    const forward = netVoltage(vactrol("VTL5C3", 0.01, load), "a");

    const text = circuit(
      partLine(new Vactrol(0, 0, 0, 0), "VTL5C3"),
      `v -96 80 -96 16 0 5 1 ${forward} 0 0 0.5`,
      "g -96 80 -96 112 0",
      "w -96 16 -16 16 0",
      "g -16 48 -16 80 0",
      "v 160 80 160 16 0 0 40 1 0 0 0.5",
      "g 160 80 160 112 0",
      "w 160 16 80 16 0",
      `r 80 48 80 112 0 ${load}`,
      "g 80 112 80 144 0",
      "207 80 48 112 48 0 out",
    );

    const { times, values } = traceOf(text, "V(out)", {
      stopTime: 0.6,
      startTime: 0.45,
      maxTimeStep: 1e-5,
      initialConditions: "dc",
    });

    // The divider reads 0.5 V when the cell is 100 kΩ.
    expect(crossing(times, values, 0.5) - 0.5).toBeCloseTo(35e-3, 3);
  });
});
