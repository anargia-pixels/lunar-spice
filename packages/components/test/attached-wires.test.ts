import { describe, expect, test } from "bun:test";

import { createElement } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { type Point, pointKey } from "@lunar-spice/simulator/geometry";
import { flipElements, rotateElements } from "@lunar-spice/simulator/layout";
import { buildNetlist } from "@lunar-spice/simulator/netlist";
import {
  deleteWithWires,
  isOnWire,
  joinPostsToWires,
  mergeWires,
} from "@lunar-spice/simulator/wiring";

import { AttachedWires } from "../src/components/circuit-editor/attached-wires";
import {
  EditorHistory,
  restoreSnapshot,
  snapshotOf,
} from "../src/components/circuit-editor/editor-history";

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

    // The horizontal lead just gets longer; only the vertical one needs a jog, which
    // comes up to the post from below rather than over the resistor.
    expect(ends(left)).toEqual([-64, 0, 32, 0]);
    expect(added.map(ends)).toEqual([[96, 64, 96, 0]]);
  });

  test("bend at a right angle instead of going diagonal", () => {
    const { resistor, left, right, loose, elements, selection } =
      resistorWithLeads();

    const wires = new AttachedWires(elements, selection);

    resistor.translate(16, 32);

    const { added } = wires.moveBy(16, 32);

    // The horizontal lead keeps its height and turns down to the moved post.
    expect(ends(left)).toEqual([-64, 0, 16, 0]);
    // The vertical lead turns along its bottom and comes up to the moved post, since
    // turning at its old column would run back over the resistor.
    expect(ends(right)).toEqual([80, 64, 64, 64]);
    expect(added.map(ends)).toEqual([
      [16, 0, 16, 32],
      [80, 64, 80, 32],
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

/**
 * Turns or flips `selected` the way the editor does: its wires follow their posts, wires
 * shrunk to a point go, and the circuit is joined again as after every edit.
 */
function transformed(
  elements: readonly CircuitElement[],
  selected: CircuitElement[],
  transform: (elements: CircuitElement[]) => void,
) {
  const wires = new AttachedWires(elements, new Set(selected), true);

  transform(selected);

  const { added, removed } = wires.followPosts();
  const gone = new Set([...removed, ...wires.collapsed()]);

  return [
    ...joinPostsToWires(
      mergeWires([
        ...elements.filter((element) => !gone.has(element)),
        ...added,
      ]),
    ),
  ];
}

/**
 * The net each of `element`'s posts is on, by name. A ground off by itself keeps the
 * netlist from making the first post ground.
 */
function netsOf(elements: readonly CircuitElement[], element: CircuitElement) {
  const ground = createElement("ground", 4096, 4096, 4096, 4112);
  const { nodeOfPoint, nodes } = buildNetlist([...elements, ground], "dc");

  return element
    .posts()
    .map((post) => nodes[nodeOfPoint.get(pointKey(post)) ?? -1]?.name);
}

/** A net label called `text` at `at`. */
function label(text: string, at: Point) {
  const element = createElement("label", at.x, at.y, at.x, at.y - 16);

  if ("text" in element) {
    element.text = text;
  }

  return element;
}

/**
 * Wires each of `part`'s posts `reach` units further out from `centre` to a net label
 * named by its index, and returns everything.
 */
function labelEachPost(part: CircuitElement, centre: Point, reach: number) {
  return [
    part,
    ...part.posts().flatMap((post, index) => {
      const dx = Math.sign(post.x - centre.x);
      const dy = dx === 0 ? Math.sign(post.y - centre.y) : 0;
      const out = { x: post.x + dx * reach, y: post.y + dy * reach };

      return [
        createElement("wire", post.x, post.y, out.x, out.y),
        label(`p${index}`, out),
      ];
    }),
  ];
}

/** The posts nothing else joins, as the editor flags them. */
function looseEnds(elements: readonly CircuitElement[]) {
  const counts = new Map<string, { point: Point; count: number }>();

  for (const element of elements) {
    for (const point of element.posts()) {
      const key = pointKey(point);

      counts.set(key, { point, count: (counts.get(key)?.count ?? 0) + 1 });
    }
  }

  return [...counts.values()].flatMap(({ point, count }) =>
    count === 1 && !isOnWire(elements, point) ? [point] : [],
  );
}

/** Wires that run at an angle, which the editor's routes never leave. */
function slanted(elements: readonly CircuitElement[]) {
  return elements.filter(
    (element) =>
      element.kind === "wire" &&
      element.x1 !== element.x2 &&
      element.y1 !== element.y2,
  );
}

/** Wires that run along `part`'s line between its posts, over its drawing. */
function wiresOver(elements: readonly CircuitElement[], part: CircuitElement) {
  const { start, end } = part;

  return elements.filter(
    (element) =>
      element.kind === "wire" &&
      [element.start, element.end, midpoint(element)].some(
        (point) =>
          (point.x - start.x) * (end.y - start.y) ===
            (point.y - start.y) * (end.x - start.x) &&
          Math.min(start.x, end.x) <= point.x &&
          point.x <= Math.max(start.x, end.x) &&
          Math.min(start.y, end.y) <= point.y &&
          point.y <= Math.max(start.y, end.y) &&
          !(point.x === start.x && point.y === start.y) &&
          !(point.x === end.x && point.y === end.y),
      ),
  );
}

/** Wires that run along an edge of the box around `part`'s posts, as if joining them. */
function wiresAlongEdge(
  elements: readonly CircuitElement[],
  part: CircuitElement,
) {
  const xs = part.posts().map(({ x }) => x);
  const ys = part.posts().map(({ y }) => y);
  const [left, right] = [Math.min(...xs), Math.max(...xs)];
  const [top, bottom] = [Math.min(...ys), Math.max(...ys)];

  const overlaps = (a: number, b: number, low: number, high: number) =>
    Math.max(Math.min(a, b), low) < Math.min(Math.max(a, b), high);

  return elements.filter(
    ({ kind, x1, y1, x2, y2 }) =>
      kind === "wire" &&
      ((x1 === x2 &&
        (x1 === left || x1 === right) &&
        overlaps(y1, y2, top, bottom)) ||
        (y1 === y2 &&
          (y1 === top || y1 === bottom) &&
          overlaps(x1, x2, left, right))),
  );
}

function midpoint({ start, end }: CircuitElement) {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

describe("wires attached to a turned or flipped selection", () => {
  const turns = [
    [
      "a quarter turn right",
      (all: CircuitElement[]) => rotateElements(all, true),
    ],
    [
      "a quarter turn left",
      (all: CircuitElement[]) => rotateElements(all, false),
    ],
    [
      "a flip left to right",
      (all: CircuitElement[]) => flipElements(all, "horizontal"),
    ],
    [
      "a flip top to bottom",
      (all: CircuitElement[]) => flipElements(all, "vertical"),
    ],
  ] as const;

  for (const [name, transform] of turns) {
    test(`follow a resistor's pins through ${name}`, () => {
      const resistor = createElement("resistor", 0, 0, 64, 0);
      const elements = labelEachPost(resistor, { x: 32, y: 0 }, 64);
      const after = transformed(elements, [resistor], transform);

      // Each pin keeps its own net, and nothing is left hanging, slanted or drawn over
      // the resistor.
      expect(netsOf(after, resistor)).toEqual(["p0", "p1"]);
      expect(looseEnds(after)).toEqual([]);
      expect(slanted(after)).toEqual([]);
      expect(wiresOver(after, resistor)).toEqual([]);
    });
  }

  test("turn a resistor with a bent lead and keep the lead on its pin", () => {
    const { resistor, left, right, elements } = resistorWithLeads();

    const after = transformed(elements, [resistor], (all) =>
      rotateElements(all, true),
    );

    // The resistor now stands from (32, -32) to (32, 32); its leads reach its new pins
    // around it instead of over it.
    expect(ends(resistor)).toEqual([32, -32, 32, 32]);
    expect(after).toContain(left);
    expect(after).toContain(right);
    expect(slanted(after)).toEqual([]);
    expect(wiresOver(after, resistor)).toEqual([]);

    const pins = after.filter(
      (element) =>
        element.kind === "wire" &&
        [element.start, element.end].some(
          (point) => point.x === 32 && Math.abs(point.y) === 32,
        ),
    );

    expect(pins).toHaveLength(2);
  });

  for (const [name, transform] of turns.slice(2)) {
    test(`follow an op-amp's five pins through ${name}`, () => {
      const opAmp = createElement("op-amp", 0, 0, 96, 0);
      const elements = labelEachPost(opAmp, { x: 48, y: 0 }, 48);

      expect(opAmp.posts()).toHaveLength(5);

      const after = transformed(elements, [opAmp], transform);

      expect(netsOf(after, opAmp)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
      expect(looseEnds(after)).toEqual([]);
      expect(slanted(after)).toEqual([]);
      expect(wiresAlongEdge(after, opAmp)).toEqual([]);
    });
  }

  test("put a turned part back as it was after four turns", () => {
    const resistor = createElement("resistor", 0, 0, 64, 0);
    const elements = labelEachPost(resistor, { x: 32, y: 0 }, 64);
    let after = elements;

    for (let turn = 0; turn < 4; turn += 1) {
      after = transformed(after, [resistor], (all) =>
        rotateElements(all, true),
      );
    }

    expect(ends(resistor)).toEqual([0, 0, 64, 0]);
    expect(netsOf(after, resistor)).toEqual(["p0", "p1"]);
    expect(looseEnds(after)).toEqual([]);
  });
});

describe("one undo step per wiring edit", () => {
  /** Applies `edit` as the editor does, then undoes it. */
  function undone(
    elements: readonly CircuitElement[],
    edit: () => readonly CircuitElement[],
  ) {
    const history = new EditorHistory(() => {});

    history.record(snapshotOf(elements));

    const after = edit();
    const before = history.undo(snapshotOf(after));

    expect(history.canUndo).toBe(false);

    return { after, restored: before ? restoreSnapshot(before) : [] };
  }

  test("undo a turn with the wires it rerouted", () => {
    const { resistor, elements } = resistorWithLeads();
    const lines = elements.map((element) => element.dump());

    const { after, restored } = undone(elements, () =>
      transformed(elements, [resistor], (all) => rotateElements(all, true)),
    );

    expect(after.map((element) => element.dump())).not.toEqual(lines);
    expect(restored.map((element) => element.dump())).toEqual(lines);
  });

  test("undo a delete with the wires it took", () => {
    const resistor = createElement("resistor", 0, 0, 64, 0);
    const elements = labelEachPost(resistor, { x: 32, y: 0 }, 64);
    const lines = elements.map((element) => element.dump());

    const { after, restored } = undone(elements, () =>
      deleteWithWires(elements, new Set([resistor])),
    );

    // The resistor's wires go with it; the labels stay.
    expect(after.map(({ kind }) => kind)).toEqual(["label", "label"]);
    expect(restored.map((element) => element.dump())).toEqual(lines);
  });
});
