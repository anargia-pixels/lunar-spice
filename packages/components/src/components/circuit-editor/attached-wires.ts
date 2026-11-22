import { createElement } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { type Point, pointKey } from "@lunar-spice/simulator/geometry";
import { wireRun } from "@lunar-spice/simulator/wiring";

import { type Axis, RouteObstacles, routeWire } from "./wire-router";

/**
 * A connection kept while the selection moves: a wire end resting on a moving post, or a
 * part that touches one directly, which gets a new wire once the post moves away.
 */
type Attachment = {
  /**
   * The wires from `fixed` to the post, in order: for a wire that was there, it first and
   * then the bends the move added; for a part's connection, only what the move added.
   */
  wires: CircuitElement[];
  /** True for a part's connection, whose wires the move adds and may take away again. */
  isNew: boolean;
  /** Which end of the wire that was there follows the post. */
  isStart: boolean;
  /** Where the moving post started. */
  from: Point;
  /** The end that stays: the wire's other end, or the part's post. */
  fixed: Point;
  /** Which way the wire leaves `fixed`; null for a wire that ran at an angle. */
  axis: Axis | null;
};

/** A wire with both ends on the selection, and where those ends started. */
type CarriedWire = { wire: CircuitElement; start: Point; end: Point };

/** A selected element and where its posts were when the move started. */
type StartingPosts = { element: CircuitElement; posts: readonly Point[] };

function isSamePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function axisOf({ start, end }: CircuitElement): Axis | null {
  return start.y === end.y
    ? "horizontal"
    : start.x === end.x
      ? "vertical"
      : null;
}

/**
 * The wires of `wire`'s run in order from `from`, each with its end away from `from`;
 * the last one's is the run's far end.
 */
function runFrom(
  elements: readonly CircuitElement[],
  wire: CircuitElement,
  from: Point,
) {
  const remaining = new Set(wireRun(elements, wire));
  const run: { wire: CircuitElement; fixed: Point }[] = [];
  let at = from;

  for (
    let next: CircuitElement | undefined = wire;
    next;
    next = [...remaining].find((other) =>
      [other.start, other.end].some((end) => isSamePoint(end, at)),
    )
  ) {
    remaining.delete(next);
    at = isSamePoint(next.start, at) ? next.end : next.start;
    run.push({ wire: next, fixed: at });
  }

  return run;
}

function setEnd(wire: CircuitElement, isStart: boolean, point: Point) {
  if (isStart) {
    wire.x1 = point.x;
    wire.y1 = point.y;
  } else {
    wire.x2 = point.x;
    wire.y2 = point.y;
  }
}

function setEnds(wire: CircuitElement, start: Point, end: Point) {
  setEnd(wire, true, start);
  setEnd(wire, false, end);
}

/**
 * The wires that keep a moving selection connected, as in Multisim. A wire with one end
 * on a moving post follows it; a part that touches a moving post directly gets a new
 * wire from its post. Each reroutes on the grid, with bends where it needs them and
 * around posts, wires and parts it would otherwise join or cover. A wire with both ends
 * on the selection moves with it. Built when the move starts, from the posts as they are
 * then; the move may slide the selection, turn it or flip it. With `isRerouted`, as for
 * a turn or flip, each wire is laid again whole from its far junction or pin, since the
 * way it ran no longer fits; otherwise only the stretch on the post follows it.
 */
export class AttachedWires {
  private readonly elements: readonly CircuitElement[];
  private readonly starting: StartingPosts[];
  private readonly carried: CarriedWire[] = [];
  private readonly attachments: Attachment[] = [];

  constructor(
    elements: readonly CircuitElement[],
    selection: ReadonlySet<CircuitElement>,
    isRerouted = false,
  ) {
    this.elements = [...elements];
    this.starting = elements.flatMap((element) =>
      selection.has(element) ? [{ element, posts: element.posts() }] : [],
    );

    const posts = new Set(
      this.starting.flatMap(({ posts: points }) => points.map(pointKey)),
    );

    // The axes of the parts that stay at each moving post, for their new wires.
    const partsAt = new Map<string, { point: Point; axes: (Axis | null)[] }>();

    for (const element of elements) {
      if (selection.has(element)) {
        continue;
      }

      if (!element.isStretchable()) {
        for (const post of element.posts()) {
          const key = pointKey(post);

          if (posts.has(key)) {
            const entry = partsAt.get(key) ?? { point: post, axes: [] };

            entry.axes.push(axisOf(element));
            partsAt.set(key, entry);
          }
        }

        continue;
      }

      const { start, end } = element;
      const isStartOn = posts.has(pointKey(start));
      const isEndOn = posts.has(pointKey(end));

      if (isStartOn && isEndOn) {
        this.carried.push({ wire: element, start, end });
      } else if (isStartOn || isEndOn) {
        const from = isStartOn ? start : end;
        const run = isRerouted ? runFrom(elements, element, from) : null;
        const far = run?.at(-1)?.fixed;

        // A run that ends on the selection again, or holds part of it, follows by its
        // stretch on the post alone.
        const isWhole =
          run !== null &&
          far !== undefined &&
          !posts.has(pointKey(far)) &&
          run.every(({ wire }) => !selection.has(wire));

        const wires = isWhole
          ? run.map(({ wire }) => wire).reverse()
          : [element];

        const [first = element] = wires;
        const fixed = isWhole && far ? far : isStartOn ? end : start;

        this.attachments.push({
          wires,
          isNew: false,
          isStart: pointKey(first.start) !== pointKey(fixed),
          from,
          fixed,
          axis: axisOf(first),
        });
      }
    }

    // One new wire per point, however many parts meet there. It leaves across the parts
    // that lie flat along a row, so it never runs back over one of them.
    for (const { point, axes } of partsAt.values()) {
      this.attachments.push({
        wires: [],
        isNew: true,
        isStart: false,
        from: point,
        fixed: point,
        axis: axes.every((axis) => axis === "horizontal")
          ? "vertical"
          : "horizontal",
      });
    }
  }

  /**
   * Places the wires for a selection moved by (`dx`, `dy`) from where it started.
   * Returns the wires to add to the circuit and the ones it no longer needs.
   */
  moveBy(dx: number, dy: number) {
    return this.place((point) => ({ x: point.x + dx, y: point.y + dy }));
  }

  /**
   * Places the wires for a selection turned or flipped since the move started: each
   * wire follows its post to wherever that post is now. Returns the wires to add to the
   * circuit and the ones it no longer needs.
   */
  followPosts() {
    const moved = new Map<string, Point>();

    for (const { element, posts } of this.starting) {
      const now = element.posts();

      posts.forEach((post, index) => {
        const key = pointKey(post);
        const target = now[index];

        if (target && !moved.has(key)) {
          moved.set(key, target);
        }
      });
    }

    return this.place((point) => moved.get(pointKey(point)) ?? point);
  }

  /** Reroutes every wire to where `targetOf` says its moving post went. */
  private place(targetOf: (point: Point) => Point) {
    const added: CircuitElement[] = [];
    const removed: CircuitElement[] = [];

    for (const { wire, start, end } of this.carried) {
      setEnds(wire, targetOf(start), targetOf(end));
    }

    // Each route keeps clear of everything else, the routes placed before it included.
    const owned = new Set(this.attachments.flatMap(({ wires }) => wires));

    const obstacles = new RouteObstacles(
      this.elements.filter((element) => !owned.has(element)),
    );

    for (const { fixed } of this.attachments) {
      obstacles.addPost(fixed);
    }

    for (const attachment of this.attachments) {
      const { from, fixed, axis, isNew, isStart, wires } = attachment;
      const target = targetOf(from);

      // A wire that ran at an angle keeps running straight to its post.
      const route =
        axis === null && !isNew
          ? [fixed, target]
          : routeWire(fixed, target, axis, obstacles);

      const stretches = route.slice(1).map((to, index) => ({
        from: route[index] ?? to,
        to,
      }));

      // The wire that was there keeps its fixed end and takes the first stretch; back
      // where it started, a part needs no wire of its own.
      const [first, ...bends] = wires;
      const kept = isNew ? [] : [first];
      const reused = isNew ? wires : bends;
      const needed = isNew ? stretches : stretches.slice(1);

      if (!isNew && first) {
        setEnd(first, isStart, stretches[0]?.to ?? fixed);
      }

      const placed = needed.map((stretch, index) => {
        const wire = reused[index];

        if (wire) {
          setEnds(wire, stretch.from, stretch.to);

          return wire;
        }

        const created = createElement(
          "wire",
          stretch.from.x,
          stretch.from.y,
          stretch.to.x,
          stretch.to.y,
        );

        added.push(created);

        return created;
      });

      removed.push(...reused.slice(needed.length));
      attachment.wires = [
        ...kept.filter((wire) => wire !== undefined),
        ...placed,
      ];

      for (const { from: start, to } of stretches) {
        obstacles.addWire(start, to);
      }
    }

    return { added, removed };
  }

  /** The wires that were there and that the move shrank to a point, to delete. */
  collapsed() {
    return this.attachments.flatMap(({ wires: [wire], isNew }) =>
      wire && !isNew && isSamePoint(wire.start, wire.end) ? [wire] : [],
    );
  }
}
