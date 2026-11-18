import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { createElement, readElementLine } from "../src/circuit";
import { OpAmp } from "../src/elements/op-amp";

/** A circuit file from element lines, with the default settings line. */
function circuit(...lines: string[]) {
  return ["$ 1 0.000005 10.2 50 5 50", ...lines].join("\n");
}

/** A new op-amp from (0, 0) to (96, 0) set to the part called `preset`. */
function opAmp(preset: string) {
  const element = createElement("op-amp", 0, 0, 96, 0);

  if (!(element instanceof OpAmp)) {
    throw new Error("Expected an op-amp");
  }

  element.params.applyPreset(preset);

  return element;
}

/**
 * The output of `preset` comparing 1 V against ground, VCC at `vcc` and VEE grounded.
 * Its posts: inverting (0, -16), non-inverting (0, 16), output (96, 0), VCC (48, -32)
 * and VEE (48, 32). `isInverted` swaps which input gets the 1 V.
 */
function comparatorOutput(preset: string, vcc: number, isInverted = false) {
  const [high, low] = isInverted ? ["-16", "16"] : ["16", "-16"];

  const text = circuit(
    opAmp(preset).dump(),
    `v 48 -96 48 -32 0 0 40 ${vcc} 0 0 0.5`,
    "g 48 -96 48 -128 0 0",
    "g 48 32 48 64 0 0",
    `v -64 ${high} 0 ${high} 0 0 40 1 0 0 0.5`,
    `g -64 ${high} -96 ${high} 0 0`,
    `g 0 ${low} -32 ${low} 0 0`,
    "207 96 0 112 0 0 out",
  );

  const net = operatingPoint(text).nets.find(({ net }) => net === "out");

  if (!net) {
    throw new Error("No net named out");
  }

  return net.voltage;
}

describe("op-amp supply posts", () => {
  test("puts VCC above the body and VEE below, halfway along", () => {
    expect(opAmp("Ideal").posts().slice(3)).toEqual([
      { x: 48, y: -32 },
      { x: 48, y: 32 },
    ]);
  });

  test("keeps Falstad's op-amps at three posts and a fixed swing", () => {
    const falstad = readElementLine("a 0 0 96 0 0 15 -15 1000000");

    expect(falstad?.posts()).toHaveLength(3);
  });

  test("round-trips its supply posts through a circuit file", () => {
    const parsed = readElementLine(opAmp("LM358").dump());

    expect(parsed).toBeInstanceOf(OpAmp);
    expect(parsed?.posts()).toHaveLength(5);
  });

  test("finds its preset in files from when presets were named for ±15 V", () => {
    const parsed = readElementLine(
      // Not String.raw: Bun's turns ± into an escape.
      "a 0 0 96 0 65536 13 -13 1000000 LM741\\s(±15\\sV) 200000 1000000 0.5 2000000 75 0.001 13 -13",
    );

    expect(parsed).toBeInstanceOf(OpAmp);
    expect(parsed?.valueLabel()).toBe("LM741");
  });

  test("swings to each supply less the datasheet's drop", () => {
    // LM358 on 9 V and ground: VCC − 1.5 V = 7.5 V high, VEE + 5 mV low. The limiter
    // gives a ten-thousandth of the swing, under a millivolt.
    expect(comparatorOutput("LM358", 9)).toBeCloseTo(7.5, 2);
    expect(comparatorOutput("LM358", 9, true)).toBeCloseTo(0.005, 2);
    // Without a gain-bandwidth product the clipped stage swings rail to rail.
    expect(comparatorOutput("Ideal", 9)).toBeCloseTo(9, 3);
    expect(comparatorOutput("Ideal", 9, true)).toBeCloseTo(0, 3);
  });

  test("follows VCC as it changes", () => {
    // 5 V − 1.5 V.
    expect(comparatorOutput("LM358", 5)).toBeCloseTo(3.5, 2);
  });

  test("holds an unpowered output at its supplies' level", () => {
    // The limiter gives a ten-thousandth of a volt here.
    expect(comparatorOutput("LM358", 0)).toBeCloseTo(0, 3);
  });
});
