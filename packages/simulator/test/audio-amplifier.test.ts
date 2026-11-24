import { describe, expect, test } from "bun:test";

import { acSweep, operatingPoint, transient } from "../src/analyses";
import { createElement, readElementLine } from "../src/circuit";
import { AudioAmplifier } from "../src/elements/audio-amplifier";

/**
 * An LM386N-3 with its first point at (0, 0). Its posts, pin 1 to 8: GAIN (16, -16),
 * −IN (-16, 32), +IN (-16, 64), GND (48, 112), OUT (112, 48), VS (80, -16),
 * BYPASS (80, 112) and GAIN (48, -16).
 */
const AMPLIFIER =
  "LS386 0 0 96 96 65536 LM386N-3 300000 50000 0.6 0.6 1.4 1 0.004 4 12";

/** The amplifier on a `supply` volt rail with GND grounded, OUT labeled `out`, and `lines`. */
function circuit(supply: number, ...lines: string[]) {
  return [
    "$ 1 0.000005 10.2 50 5 50",
    AMPLIFIER,
    `R 80 -16 80 -48 0 0 40 ${supply} 0 0 0.5`,
    "g 48 112 48 144 0 0",
    "207 112 48 144 48 0 out",
    "207 80 112 80 144 0 bypass",
    ...lines,
  ].join("\n");
}

/** A DC rail of `volts` on +IN. */
function nonInverting(volts: number) {
  return `R -16 64 -48 64 0 0 40 ${volts} 0 0 0.5`;
}

/** An 8 Ω speaker's load from OUT to a 4.5 V rail, as if through its coupling capacitor. */
const SPEAKER_LOAD = [
  "r 112 48 112 160 0 8",
  "R 112 160 112 192 0 0 40 4.5 0 0 0.5",
];

/** A capacitor across pins 1 and 8 large enough to short the 1.35 kΩ. */
const GAIN_CAPACITOR = "c 16 -16 48 -16 0 0.001 0";

function netVoltage(text: string, name: string) {
  const net = operatingPoint(text).nets.find(
    (candidate) => candidate.net === name,
  );

  if (!net) {
    throw new Error(`No net named ${name}`);
  }

  return net.voltage;
}

/** The gain from a 10 mV sine on +IN to OUT at each frequency from `start` up. */
function acGain(start: number, ...lines: string[]) {
  const result = acSweep(
    circuit(9, "R -16 64 -48 64 0 1 1000 0.01 0 0 0.5", ...lines),
    {
      startFrequency: start,
      stopFrequency: start * 10,
      scale: "decade",
      points: 10,
    },
  );

  const out = result.nets.find(({ name }) => name === "V(out)");

  return (out?.magnitude ?? []).map((magnitude) => magnitude / 0.01);
}

/** Loop gain inside the model: gains come out short by 1 / (1 + 10 000). */
const LOOP_ERROR = 10_000 / 10_001;

describe("LM386 audio amplifier", () => {
  test("biases OUT and BYPASS to half the supply with the inputs open", () => {
    const text = circuit(9);

    expect(netVoltage(text, "out")).toBeCloseTo(4.5, 2);
    expect(netVoltage(text, "bypass")).toBeCloseTo(4.5, 6);
  });

  test("draws its 4 mA quiescent current at 6 V", () => {
    const rail = operatingPoint(circuit(6)).elements.find(
      ({ designator }) => designator === "V1",
    );

    expect(rail?.current).toBeCloseTo(4e-3, 5);
  });

  test("has a gain of 2 × 15 kΩ / (150 Ω + 1.35 kΩ) = 20 with pins 1 and 8 open", () => {
    // 100 mV on +IN moves OUT up 2 V from 4.5 V; on −IN, down 2 V.
    expect(netVoltage(circuit(9, nonInverting(0.1)), "out")).toBeCloseTo(
      6.5,
      2,
    );
    expect(
      netVoltage(circuit(9, "R -16 32 -48 32 0 0 40 0.1 0 0 0.5"), "out"),
    ).toBeCloseTo(2.5, 2);
    expect(acGain(1000)[0]).toBeCloseTo(20 * LOOP_ERROR, 3);
  });

  test("has a gain of 2 × 15 kΩ / 150 Ω = 200 with a capacitor across pins 1 and 8", () => {
    // At 1 kHz, 1 mF is 0.16 Ω beside the 1.35 kΩ.
    expect(acGain(1000, GAIN_CAPACITOR)[0]).toBeCloseTo(200, 0);
  });

  test("sets gains in between with a resistor and capacitor across pins 1 and 8", () => {
    // 1.2 kΩ beside 1.35 kΩ is 635.3 Ω: 30 kΩ / 785.3 Ω = 38.2.
    const gain = acGain(
      1000,
      "r 16 -16 16 -48 0 1200",
      "c 16 -48 48 -48 0 0.001 0",
      "w 48 -48 48 -16 0",
    )[0];

    expect(gain).toBeCloseTo(30_000 / (150 + (1350 * 1200) / 2550), 1);
  });

  test("is 3 dB down at its 300 kHz bandwidth", () => {
    expect(acGain(300_000)[0]).toBeCloseTo((20 * LOOP_ERROR) / Math.SQRT2, 1);
  });

  test("clips about 1.2 V from each rail into 8 Ω", () => {
    // The drive stops 0.6 V inside each rail: 8.4 V and 0.6 V. Into 8 Ω to 4.5 V, the
    // 1.4 Ω output resistance (flattening toward the 1 A limit) solves 8 × i =
    // 3.9 V − 1.4 Ω × atanh(i / 1 A) at i = 0.411 A: OUT reaches 4.5 + 3.29 = 7.79 V, and
    // by symmetry 1.21 V.
    const high = netVoltage(
      circuit(9, nonInverting(0.5), ...SPEAKER_LOAD),
      "out",
    );

    const low = netVoltage(
      circuit(9, nonInverting(-0.5), ...SPEAKER_LOAD),
      "out",
    );

    expect(high).toBeCloseTo(7.79, 1);
    expect(low).toBeCloseTo(1.21, 1);
    expect(9 - high).toBeGreaterThan(1);
    expect(9 - high).toBeLessThan(1.5);
  });

  test("clips a sine at the same levels in a transient run", () => {
    // 0.3 V × 20 asks for a 6 V peak, past both clipping levels.
    const result = transient(
      circuit(9, "R -16 64 -48 64 0 1 1000 0.3 0 0 0.5", ...SPEAKER_LOAD),
      {
        stopTime: 3e-3,
        startTime: 1e-3,
        maxTimeStep: 1e-6,
        initialConditions: "dc",
      },
    );

    const values =
      result.traces.find(({ name }) => name === "V(out)")?.values ?? [];

    expect(Math.max(...values)).toBeCloseTo(7.79, 1);
    expect(Math.min(...values)).toBeCloseTo(1.21, 1);
  });

  test("limits its output current into a short", () => {
    const result = operatingPoint(
      circuit(
        9,
        nonInverting(0.5),
        "r 112 48 112 112 0 0.001",
        "g 112 112 112 128 0 0",
      ),
    );

    const amplifier = result.elements.find(
      ({ designator }) => designator === "U1",
    );

    expect(amplifier?.current).toBeCloseTo(1, 2);
  });

  test("round-trips through a circuit file", () => {
    const parsed = readElementLine(AMPLIFIER);

    expect(parsed).toBeInstanceOf(AudioAmplifier);
    expect(parsed?.dump()).toBe(AMPLIFIER);
    expect(parsed?.posts()).toEqual([
      { x: 16, y: -16 },
      { x: -16, y: 32 },
      { x: -16, y: 64 },
      { x: 48, y: 112 },
      { x: 112, y: 48 },
      { x: 80, y: -16 },
      { x: 80, y: 112 },
      { x: 48, y: -16 },
    ]);
  });

  test("places at its own size and defaults to the LM386N-1", () => {
    const amplifier = createElement("audio-amplifier", 32, 64, 32, 64);

    expect(amplifier.dump()).toBe(
      "LS386 32 64 128 160 65536 LM386N-1 300000 50000 0.6 0.6 1.4 1 0.004 4 12",
    );
  });
});
