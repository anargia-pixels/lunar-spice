import { describe, expect, test } from "bun:test";

import { createElement } from "../src/circuit";
import type { CircuitElement } from "../src/element";
import { deleteWithWires, mergeWires, wireRun } from "../src/wiring";

function wire(x1: number, y1: number, x2: number, y2: number) {
  return createElement("wire", x1, y1, x2, y2);
}

/** The two ends of each element as `[x1, y1, x2, y2]`. */
function ends(elements: readonly CircuitElement[]) {
  return elements.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2]);
}

/**
 * R1 wired by two stretches to a junction at (128, 0), from which one wire runs down to
 * R2 and one across to R3.
 */
function junctionCircuit() {
  const r1 = createElement("resistor", 0, 0, 64, 0);
  const r2 = createElement("resistor", 128, 64, 128, 128);
  const r3 = createElement("resistor", 192, 0, 256, 0);
  const toBend = wire(64, 0, 96, 0);
  const toJunction = wire(96, 0, 128, 0);
  const down = wire(128, 0, 128, 64);
  const across = wire(128, 0, 192, 0);

  return {
    r1,
    r2,
    r3,
    toBend,
    toJunction,
    down,
    across,
    elements: [r1, r2, r3, toBend, toJunction, down, across],
  };
}

describe("wire runs", () => {
  test("run from a pin through bends to the first junction", () => {
    const { elements, toBend, toJunction } = junctionCircuit();

    expect(wireRun(elements, toJunction)).toEqual([toBend, toJunction]);
  });

  test("stop at a junction of three wires", () => {
    const { elements, down } = junctionCircuit();

    expect(wireRun(elements, down)).toEqual([down]);
  });

  test("leave a part on its own", () => {
    const { elements, r1 } = junctionCircuit();

    expect(wireRun(elements, r1)).toEqual([r1]);
  });
});

describe("deleting with wires", () => {
  test("delete a part's wires back to the junction, which joins the rest", () => {
    const { elements, r1, r2, r3, down, across } = junctionCircuit();
    const left = deleteWithWires(elements, new Set([r1]));

    // The run to R1 goes; R2 and R3 stay joined through what was the junction.
    expect(left).toEqual([r2, r3, down, across]);
    expect(wireRun(left, down)).toEqual([down, across]);
  });

  test("merge a junction left with two wires in line into one wire", () => {
    const r1 = createElement("resistor", 0, 0, 64, 0);
    const r2 = createElement("resistor", 192, 0, 256, 0);
    const r3 = createElement("resistor", 128, 64, 128, 128);
    const from1 = wire(64, 0, 128, 0);
    const to2 = wire(128, 0, 192, 0);
    const to3 = wire(128, 0, 128, 64);

    const left = mergeWires(
      deleteWithWires([r1, r2, r3, from1, to2, to3], new Set([r3])),
    );

    expect(ends(left)).toEqual(ends([r1, r2, wire(64, 0, 192, 0)]));
  });

  test("delete the wire between two parts with one of them", () => {
    const r1 = createElement("resistor", 0, 0, 64, 0);
    const r2 = createElement("resistor", 128, 0, 192, 0);
    const between = wire(64, 0, 128, 0);

    expect(deleteWithWires([r1, r2, between], new Set([r1]))).toEqual([r2]);
  });

  test("keep both wires at a pin that was a junction", () => {
    const r1 = createElement("resistor", 0, 0, 64, 0);
    const r2 = createElement("resistor", 64, 64, 64, 128);
    const r3 = createElement("resistor", 128, 0, 192, 0);
    const down = wire(64, 0, 64, 64);
    const across = wire(64, 0, 128, 0);

    // R2 and R3 met R1 at its pin; they stay joined once R1 goes.
    expect(deleteWithWires([r1, r2, r3, down, across], new Set([r1]))).toEqual([
      r2,
      r3,
      down,
      across,
    ]);
  });

  test("delete a whole dangling run from any of its wires", () => {
    const resistor = createElement("resistor", 0, 0, 64, 0);
    const first = wire(64, 0, 64, -32);
    const middle = wire(64, -32, 128, -32);
    const last = wire(128, -32, 128, -64);
    const elements = [resistor, first, middle, last];

    expect(wireRun(elements, middle)).toEqual([first, middle, last]);
    expect(deleteWithWires(elements, new Set([middle]))).toEqual([resistor]);
  });

  test("leave a loose wire that was loose before alone", () => {
    const { elements, r1, r2, r3, down, across } = junctionCircuit();
    const stub = wire(192, 0, 192, -32);
    const left = deleteWithWires([...elements, stub], new Set([r2]));

    // R2's wire goes; the stub at R3's pin was loose already and stays.
    expect(left).toEqual([r1, r3, ...elements.slice(3, 5), across, stub]);
    expect(left).not.toContain(down);
  });
});
