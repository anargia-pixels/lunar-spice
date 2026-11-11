import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { Circuit, readElementLine } from "../src/circuit";
import {
  Potentiometer,
  Resistor,
  VariableResistor,
} from "../src/elements/passive";

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

/** A 10 V source across a vertical 1 kΩ pot's track, which is grounded at the bottom. */
function divider(position: number) {
  const potentiometer = new Potentiometer(0, 0, 0, 100);

  potentiometer.position = position;

  const wiper = potentiometer.posts()[2] ?? { x: 0, y: 0 };

  return circuit(
    "v 0 100 0 0 0 0 40 10 0 0 0.5",
    `174 0 0 0 100 0 1000 ${position} Resistance`,
    "g 0 100 0 132 0 0",
    `207 ${wiper.x} ${wiper.y} ${wiper.x + 16} ${wiper.y} 0 wiper`,
  );
}

describe("potentiometer", () => {
  test("splits its track at the wiper position", () => {
    expect(netVoltage(divider(0.5), "wiper")).toBeCloseTo(5, 6);
    expect(netVoltage(divider(0.25), "wiper")).toBeCloseTo(7.5, 6);
    expect(netVoltage(divider(1), "wiper")).toBeCloseTo(0, 4);
  });

  test("drives a load from its Thevenin resistance", () => {
    // At half travel each half is 500 Ω, so the wiper's source is 5 V behind 250 Ω;
    // with 1 kΩ to ground: 5 V × 1 / 1.25 = 4 V.
    const loaded = circuit(
      "v 0 100 0 0 0 0 40 10 0 0 0.5",
      "174 0 0 0 100 0 1000 0.5 Resistance",
      "r 16 50 16 100 0 1000",
      "w 16 100 0 100 0",
      "g 0 100 0 132 0 0",
      "207 16 50 32 50 0 wiper",
    );

    expect(netVoltage(loaded, "wiper")).toBeCloseTo(4, 6);
  });

  test("puts its wiper 16 units beside the track", () => {
    const potentiometer = new Potentiometer(0, 0, 0, 100);
    const wiper = potentiometer.posts()[2];

    expect(wiper).toEqual({ x: 16, y: 50 });
  });

  test("round-trips Falstad's type and slider label", () => {
    const line = "174 0 0 0 100 0 1000 0.25 Pot";
    const parsed = readElementLine(line);

    expect(parsed).toBeInstanceOf(Potentiometer);
    expect(parsed?.dump()).toBe(line);
  });
});

describe("two-pin potentiometer", () => {
  test("scales the resistance by the dial", () => {
    const variableResistor = new VariableResistor(0, 0, 64, 0);

    variableResistor.maxResistance = 10_000;
    variableResistor.editFields()[1]?.set(25);

    expect(variableResistor.resistance).toBe(2500);
  });

  test("writes Falstad's resistor type with the effective value first", () => {
    const variableResistor = new VariableResistor(0, 0, 64, 0);

    variableResistor.maxResistance = 10_000;
    variableResistor.editFields()[1]?.set(25);

    const line = variableResistor.dump();

    expect(line.startsWith("r 0 0 64 0 ")).toBe(true);

    const parsed = readElementLine(line);

    expect(parsed).toBeInstanceOf(VariableResistor);

    if (!(parsed instanceof VariableResistor)) {
      throw new Error("Expected a variable resistor");
    }

    expect(parsed.maxResistance).toBe(10_000);
    expect(parsed.position).toBeCloseTo(0.25, 12);
    expect(parsed.resistance).toBeCloseTo(2500, 12);
  });

  test("leaves plain resistor lines as resistors", () => {
    const parsed = readElementLine("r 0 0 64 0 0 1000");

    expect(parsed).toBeInstanceOf(Resistor);
    expect(parsed).not.toBeInstanceOf(VariableResistor);
  });

  test("behaves as a resistor at its set value", () => {
    const circuitFile = circuit(
      "v 0 100 0 0 0 0 40 10 0 0 0.5",
      "r 0 0 0 100 32768 2500 10000 0.25",
      "g 0 100 0 132 0 0",
    );

    const variableResistor = Circuit.parse(circuitFile).elements.find(
      (element) => element instanceof VariableResistor,
    );

    const measured = operatingPoint(circuitFile).elements.find(
      (element) => element.name === "Variable resistor",
    );

    expect(variableResistor).toBeInstanceOf(VariableResistor);
    expect(measured?.current).toBeCloseTo(10 / 2500, 9);
  });
});
