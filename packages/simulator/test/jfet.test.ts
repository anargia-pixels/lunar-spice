import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { Circuit, readElementLine } from "../src/circuit";
import { EXTENDED_FORMAT_FLAG } from "../src/element";
import { Jfet } from "../src/elements/semiconductors";

/** A circuit file from element lines, with the default settings line. */
function circuit(...lines: string[]) {
  return ["$ 1 0.000005 10.2 50 5 50", ...lines].join("\n");
}

/** The voltage of a named net in an operating point. */
function netVoltage(text: string, name: string) {
  const net = operatingPoint(text).nets.find(
    (candidate) => candidate.net === name,
  );

  if (!net) {
    throw new Error(`No net named ${name}`);
  }

  return net.voltage;
}

/**
 * A generic N-channel JFET (VTO 4 V, BETA 0.625 mA/V², so Idss 10 mA) with its gate
 * grounded, its drain fed from a 12 V rail through `drainOhms` and its source to ground
 * through `sourceOhms`, or straight to ground at 0. Nets `drain` and `source` are labeled.
 */
function stage(drainOhms: number, sourceOhms: number) {
  const [, source, drain] = new Jfet(0, 64, 32, 64).posts();

  if (!source || !drain) {
    throw new Error("A JFET has three posts");
  }

  const drainTop = { x: drain.x, y: drain.y - 96 };
  const sourceBottom = { x: source.x, y: source.y + 96 };

  return circuit(
    "j 0 64 32 64 0 -4 0.00125",
    "g 0 64 0 96 0 0",
    `r ${drain.x} ${drain.y} ${drainTop.x} ${drainTop.y} 0 ${drainOhms}`,
    `R ${drainTop.x} ${drainTop.y} ${drainTop.x} ${drainTop.y - 32} 0 0 40 12 0 0 0.5`,
    sourceOhms > 0
      ? `r ${source.x} ${source.y} ${sourceBottom.x} ${sourceBottom.y} 0 ${sourceOhms}`
      : `w ${source.x} ${source.y} ${sourceBottom.x} ${sourceBottom.y} 0`,
    `g ${sourceBottom.x} ${sourceBottom.y} ${sourceBottom.x} ${sourceBottom.y + 32} 0 0`,
    `207 ${drain.x} ${drain.y} ${drain.x + 32} ${drain.y} 0 drain`,
    `207 ${source.x} ${source.y} ${source.x + 32} ${source.y} 0 source`,
  );
}

describe("JFET", () => {
  test("reads Falstad's line as Idss = ½ β VTO² with VTO negative", () => {
    const jfet = readElementLine("j 0 64 32 64 0 -4 0.00125");

    expect(jfet).toBeInstanceOf(Jfet);

    if (!(jfet instanceof Jfet)) {
      return;
    }

    expect(jfet.params.get("vto")).toBe(4);
    expect(jfet.params.get("beta")).toBeCloseTo(6.25e-4, 12);
    expect(jfet.dump()).toStartWith("j 0 64 32 64");
    expect(jfet.dump()).toContain(" -4 0.00125");
  });

  test("conducts Idss with the gate at the source", () => {
    // Saturated, as Vds = 12 − 0.5k × 10 mA = 7 V is above the 4 V pinch-off:
    // Id = BETA × VTO² = 0.625 m × 16 = 10 mA.
    expect(netVoltage(stage(500, 0), "drain")).toBeCloseTo(7, 3);
  });

  test("self-biases through a source resistor", () => {
    // Vgs = −200 Id, so Id = BETA (4 − 200 Id)², or 25 Id² − 2 Id + 0.01 = 0. The root
    // above pinch-off is Id = (2 − √3) / 50 ≈ 5.359 mA, putting the source at 1.072 V.
    const current = (2 - Math.sqrt(3)) / 50;
    const text = stage(500, 200);

    expect(netVoltage(text, "source")).toBeCloseTo(200 * current, 3);
    expect(netVoltage(text, "drain")).toBeCloseTo(12 - 500 * current, 3);
  });

  test("conducts through the gate junction when the gate is forward biased", () => {
    // 5 V into the gate through 10 kΩ, source grounded: the gate sits a diode drop up.
    const [, source] = new Jfet(0, 64, 32, 64).posts();

    if (!source) {
      throw new Error("A JFET has three posts");
    }

    const text = circuit(
      "j 0 64 32 64 0 -4 0.00125",
      "r 0 64 -64 64 0 10000",
      "R -64 64 -96 64 0 0 40 5 0 0 0.5",
      `w ${source.x} ${source.y} ${source.x} ${source.y + 96} 0`,
      `g ${source.x} ${source.y + 96} ${source.x} ${source.y + 128} 0 0`,
      "207 0 64 0 32 0 gate",
    );

    const gate = netVoltage(text, "gate");

    expect(gate).toBeGreaterThan(0.5);
    expect(gate).toBeLessThan(0.9);
  });

  test("round-trips a preset through the extended format", () => {
    const jfet = new Jfet(0, 64, 32, 64);

    jfet.params.applyPreset("2N3819");

    const copy = Circuit.parse(circuit(jfet.dump())).elements[0];

    expect(copy).toBeInstanceOf(Jfet);
    expect(copy instanceof Jfet && copy.params.modelName).toBe("2N3819");
    expect(copy instanceof Jfet && copy.params.get("vto")).toBe(3);
  });
});

describe("part labels", () => {
  test("keep a plain Falstad line until moved or renamed", () => {
    expect(readElementLine("r 0 0 64 0 0 1000")?.dump()).toBe(
      "r 0 0 64 0 0 1000",
    );
  });

  test("round-trip a moved, renamed label behind the extended flag", () => {
    const resistor = readElementLine("r 0 0 64 0 0 1000");

    if (!resistor) {
      throw new Error("A resistor line reads");
    }

    resistor.labelOffset = { x: 8, y: -12 };
    resistor.customName = "R load";

    const copy = Circuit.parse(circuit(resistor.dump())).elements[0];

    expect(copy?.labelOffset).toEqual({ x: 8, y: -12 });
    expect(copy?.customName).toBe("R load");
    expect(copy?.designator).toBe("R load");
    expect(copy?.flags).toBe(EXTENDED_FORMAT_FLAG);
    expect(copy && "resistance" in copy && copy.resistance).toBe(1000);
  });

  test("leave other parts numbered when one is named", () => {
    const text = circuit(
      "r 0 0 64 0 0 1000 @label 0 0 Rload",
      "r 0 64 64 64 0 2000",
    );

    expect(Circuit.parse(text).elements.map((e) => e.designator)).toEqual([
      "Rload",
      "R2",
    ]);
  });

  test("put the label back in place when the part turns", () => {
    const resistor = readElementLine("r 0 0 64 0 0 1000 @label 4 4");

    resistor?.transform(({ x, y }) => ({ x: -y, y: x }));
    expect(resistor?.labelOffset).toEqual({ x: 0, y: 0 });
  });

  test("keep a JFET's parameters ahead of its label", () => {
    const jfet = new Jfet(0, 64, 32, 64);

    jfet.params.applyPreset("2N5457");
    jfet.labelOffset = { x: -10, y: 6 };

    const copy = readElementLine(jfet.dump());

    expect(copy instanceof Jfet && copy.params.modelName).toBe("2N5457");
    expect(copy?.labelOffset).toEqual({ x: -10, y: 6 });
  });
});
