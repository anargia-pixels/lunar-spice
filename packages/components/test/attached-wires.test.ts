import { describe, expect, test } from "bun:test";

import { createElement } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";

import { AttachedWires } from "../src/components/circuit-editor/attached-wires";

/** The two ends of an element as `[x1, y1, x2, y2]`. */
function ends(element: CircuitElement) {
  return [element.x1, element.y1, element.x2, element.y2];
}

/** A resistor from (0, 0) to (64, 0) with a wire leaving each end, and the selection. */
function resistorWithLeads() {
  const resistor = createElement("resistor", 0, 0, 64, 0);
  const left = createElement("wire", -64, 0, 0, 0);
  const right = createElement("wire", 64, 0, 64, 64);
  const loose = createElement("wire", 200, 0, 264, 0);

  return {
    resistor,
    left,
    right,
    loose,
    elements: [resistor, left, right, loose],
    selection: new Set([resistor]),
  };
}

describe("wires attached to a moving selection", () => {
  test("stretch along their own axis without a bend", () => {
    const { resistor, left, elements, selection } = resistorWithLeads();
    const wires = new AttachedWires(elements, selection);

    resistor.translate(32, 0);

    const { added } = wires.moveBy(32, 0);

    // The horizontal lead just gets longer; only the vertical one needs a jog.
    expect(ends(left)).toEqual([-64, 0, 32, 0]);
    expect(added.map(ends)).toEqual([[64, 0, 96, 0]]);
  });

  test("bend at a right angle instead of going diagonal", () => {
    const { resistor, left, right, loose, elements, selection } =
      resistorWithLeads();

    const wires = new AttachedWires(elements, selection);

    resistor.translate(16, 32);

    const { added } = wires.moveBy(16, 32);

    // The horizontal lead keeps its height and turns down to the moved post.
    expect(ends(left)).toEqual([-64, 0, 16, 0]);
    // The vertical lead keeps its column and turns across to the moved post.
    expect(ends(right)).toEqual([64, 32, 64, 64]);
    expect(added.map(ends)).toEqual([
      [16, 0, 16, 32],
      [64, 32, 80, 32],
    ]);
    // A wire touching nothing that moved stays put.
    expect(ends(loose)).toEqual([200, 0, 264, 0]);
  });

  test("drop a bend once the move no longer needs it", () => {
    const { resistor, elements, selection } = resistorWithLeads();
    const wires = new AttachedWires(elements, selection);

    resistor.translate(0, 32);

    const first = wires.moveBy(0, 32);

    resistor.translate(0, -32);

    const second = wires.moveBy(0, 0);

    expect(second.removed).toEqual(first.added);
  });

  test("carry a wire whose ends are both on the selection", () => {
    const a = createElement("resistor", 0, 0, 0, 64);
    const b = createElement("resistor", 64, 0, 64, 64);
    const bridge = createElement("wire", 0, 0, 64, 0);
    const wires = new AttachedWires([a, b, bridge], new Set([a, b]));

    wires.moveBy(16, 16);

    expect(ends(bridge)).toEqual([16, 16, 80, 16]);
  });

  test("report a wire shrunk to a point", () => {
    const { resistor, left, elements, selection } = resistorWithLeads();
    const wires = new AttachedWires(elements, selection);

    resistor.translate(-64, 0);
    wires.moveBy(-64, 0);

    expect(wires.collapsed()).toEqual([left]);
  });

  test("add a wire to a part that touched a moved post directly", () => {
    const fixed = createElement("resistor", 0, 0, 64, 0);
    const moving = createElement("resistor", 64, 0, 128, 0);
    const wires = new AttachedWires([fixed, moving], new Set([moving]));

    moving.translate(32, 32);

    const { added } = wires.moveBy(32, 32);

    // It leaves across the flat resistor, down, then turns to the moved post.
    expect(added.map(ends)).toEqual([
      [64, 0, 64, 32],
      [64, 32, 96, 32],
    ]);

    moving.translate(-32, -32);

    expect(wires.moveBy(0, 0).removed).toEqual(added);
  });

  test("add one wire where several parts meet a moved post", () => {
    const left = createElement("resistor", 0, 0, 64, 0);
    const label = createElement("label", 64, 0, 112, 0);
    const moving = createElement("capacitor", 64, 0, 64, 128);

    const wires = new AttachedWires([left, label, moving], new Set([moving]));

    moving.translate(64, 0);

    // The resistor and the label share the post; one straight wire serves both.
    expect(wires.moveBy(64, 0).added.map(ends)).toEqual([[64, 0, 128, 0]]);
  });
});
