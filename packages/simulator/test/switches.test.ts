import { describe, expect, test } from "bun:test";

import { operatingPoint } from "../src/analyses";
import { Circuit } from "../src/circuit";
import { SpdtSwitch, Switch } from "../src/elements/connectors";
import { Simulation } from "../src/simulation";

/** The current through each designated element, by designator. */
function currents(text: string) {
  return new Map(
    operatingPoint(text).elements.map(({ designator, current }) => [
      designator,
      current,
    ]),
  );
}

describe("analysis results", () => {
  test("a closed switch reports the 5 mA it carries into 1 kΩ", () => {
    const text = [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      "s 0 0 64 0 0 0 false",
      "r 64 0 64 64 0 1000",
      "g 64 64 64 80 0 0",
    ].join("\n");

    expect(Math.abs(currents(text).get("S1") ?? 0)).toBeCloseTo(0.005, 6);
  });

  test("a switch opened during a run carries nothing, nor do its wires", () => {
    const circuit = Circuit.parse(
      [
        "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
        "w 0 0 32 0 0",
        "s 32 0 96 0 0 0 false",
        "r 96 0 96 64 0 1000",
        "g 96 64 96 80 0 0",
      ].join("\n"),
    );

    const [, wire, button] = circuit.elements;

    expect(new Simulation(circuit.elements, "transient", 5e-6).step()).toBe(
      true,
    );
    expect(Math.abs(wire?.current ?? 0)).toBeCloseTo(0.005, 6);

    // The editor rebuilds the simulation after every toggle, on the same elements.
    button?.toggle();
    expect(new Simulation(circuit.elements, "transient", 5e-6).step()).toBe(
      true,
    );
    expect(button?.current).toBe(0);
    expect(wire?.current).toBeCloseTo(0, 9);
  });
});

describe("push switches", () => {
  /** 5 V through a push switch into 1 kΩ: 5 mA when it conducts. */
  function pushCircuit(position: number) {
    return [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      `s 0 0 64 0 0 ${position} true`,
      "r 64 0 64 64 0 1000",
      "g 64 64 64 80 0 0",
    ].join("\n");
  }

  test("normally open conducts only while held", () => {
    const circuit = Circuit.parse(pushCircuit(1));
    const button = circuit.elements[1];

    expect(button).toBeInstanceOf(Switch);

    if (!(button instanceof Switch)) {
      return;
    }

    expect(button.isClosed).toBe(false);
    button.press(true);
    expect(button.isClosed).toBe(true);
    button.press(false);
    expect(button.isClosed).toBe(false);
    expect(currents(pushCircuit(1)).get("R1")).toBeCloseTo(0, 9);
  });

  test("normally closed conducts 5 mA until held, and saves its rest position", () => {
    const circuit = Circuit.parse(pushCircuit(0));
    const button = circuit.elements[1];

    if (!(button instanceof Switch)) {
      throw new Error("Expected a switch");
    }

    expect(button.isNormallyClosed).toBe(true);
    expect(currents(pushCircuit(0)).get("R1")).toBeCloseTo(5e-3, 9);
    button.press(true);
    expect(button.isClosed).toBe(false);
    // Saving while held still writes the rest position.
    expect(button.dump()).toBe("s 0 0 64 0 0 0 true");
  });
});

describe("changeover switch", () => {
  /**
   * 5 V on the common post; throw 1 (at 64, -16) feeds 1 kΩ, throw 2 (at 64, 16) feeds
   * 2 kΩ, both to ground.
   */
  function changeover(position: number) {
    return [
      "R 0 0 0 -32 0 0 40 5 0 0 0.5 0",
      `S 0 0 64 0 0 ${position} false 0`,
      "r 64 -16 128 -16 0 1000",
      "r 64 16 128 16 0 2000",
      "w 128 -16 128 16 0",
      "g 128 16 128 32 0 0",
    ].join("\n");
  }

  test("places its throws either side of the end, as Falstad does", () => {
    const [, element] = Circuit.parse(changeover(0)).elements;

    expect(element?.posts()).toEqual([
      { x: 0, y: 0 },
      { x: 64, y: -16 },
      { x: 64, y: 16 },
    ]);
  });

  test("feeds 5 mA to throw 1, then 2.5 mA to throw 2 when flipped", () => {
    const first = currents(changeover(0));

    expect(first.get("R1")).toBeCloseTo(5e-3, 9);
    expect(first.get("R2")).toBeCloseTo(0, 9);

    const circuit = Circuit.parse(changeover(0));
    const element = circuit.elements[1];

    if (!(element instanceof SpdtSwitch)) {
      throw new Error("Expected a changeover switch");
    }

    element.toggle();

    const flipped = currents(circuit.dump());

    expect(flipped.get("R1")).toBeCloseTo(0, 9);
    expect(flipped.get("R2")).toBeCloseTo(2.5e-3, 9);
  });
});
