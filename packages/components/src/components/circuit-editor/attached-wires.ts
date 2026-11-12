import { createElement } from "@lunar-spice/simulator/circuit";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { type Point, pointKey } from "@lunar-spice/simulator/geometry";

type Axis = "horizontal" | "vertical";

/**
 * A connection kept while the selection moves: a wire end resting on a moving post, or a
 * part that touches one directly, which gets a new wire once the post moves away.
 */
type Attachment = {
  /** The wire that follows: one that was there, or the new one, once it is needed. */
  wire: CircuitElement | null;
  /** True for a part's connection, whose wire the move adds and may take away again. */
  isNew: boolean;
  /** Which end of `wire` follows the post; a new wire follows with its end. */
  isStart: boolean;
  /** Where the moving post started. */
  from: Point;
  /** The end that stays: the wire's other end, or the part's post. */
  fixed: Point;
  /** Which way the wire leaves `fixed`; null for a wire that ran at an angle. */
  axis: Axis | null;
  /** The second wire that keeps it square, while it needs one. */
  bend: CircuitElement | null;
};

/** A wire with both ends on the selection, and where those ends started. */
type CarriedWire = { wire: CircuitElement; start: Point; end: Point };

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
 * Where a wire leaving `fixed` along `axis` turns toward `target`, keeping it square;
 * null when it reaches `target` in a straight line or ran at an angle to begin with.
 */
function cornerFor(axis: Axis | null, fixed: Point, target: Point) {
  if (axis === null) {
    return null;
  }

  const corner =
    axis === "horizontal"
      ? { x: target.x, y: fixed.y }
      : { x: fixed.x, y: target.y };

  return isSamePoint(corner, target) || isSamePoint(corner, fixed)
    ? null
    : corner;
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
 * The wires that keep a moving selection connected. A wire with one end on a moving post
 * stretches to follow it; a part that touches a moving post directly gets a new wire
 * from its post. Where following straight would leave a wire at an angle, a second wire
 * adds a right-angle bend, so wiring stays on the grid. A wire with both ends on the
 * selection moves whole. Built when the move starts, from the posts as they are then.
 */
export class AttachedWires {
  private readonly carried: CarriedWire[] = [];
  private readonly attachments: Attachment[] = [];

  constructor(
    elements: readonly CircuitElement[],
    selection: ReadonlySet<CircuitElement>,
  ) {
    const posts = new Set(
      elements
        .filter((element) => selection.has(element))
        .flatMap((element) => element.posts().map(pointKey)),
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
        this.attachments.push({
          wire: element,
          isNew: false,
          isStart: isStartOn,
          from: isStartOn ? start : end,
          fixed: isStartOn ? end : start,
          axis: axisOf(element),
          bend: null,
        });
      }
    }

    // One new wire per point, however many parts meet there. It leaves across the parts
    // that lie flat along a row, so it never runs back over one of them.
    for (const { point, axes } of partsAt.values()) {
      this.attachments.push({
        wire: null,
        isNew: true,
        isStart: false,
        from: point,
        fixed: point,
        axis: axes.every((axis) => axis === "horizontal")
          ? "vertical"
          : "horizontal",
        bend: null,
      });
    }
  }

  /**
   * Places the wires for a selection moved by (`dx`, `dy`) from where it started.
   * Returns the wires to add to the circuit and the ones it no longer needs.
   */
  moveBy(dx: number, dy: number) {
    const added: CircuitElement[] = [];
    const removed: CircuitElement[] = [];

    const drop = (wire: CircuitElement | null) => {
      if (wire) {
        removed.push(wire);
      }

      return null;
    };

    for (const { wire, start, end } of this.carried) {
      setEnds(
        wire,
        { x: start.x + dx, y: start.y + dy },
        { x: end.x + dx, y: end.y + dy },
      );
    }

    for (const attachment of this.attachments) {
      const { from, fixed, axis } = attachment;
      const target = { x: from.x + dx, y: from.y + dy };

      // Back where it started, a part needs no wire of its own.
      if (attachment.isNew && isSamePoint(target, fixed)) {
        attachment.wire = drop(attachment.wire);
        attachment.bend = drop(attachment.bend);
        continue;
      }

      const corner = cornerFor(axis, fixed, target);
      const reach = corner ?? target;

      if (attachment.wire) {
        setEnd(attachment.wire, attachment.isStart, reach);
      } else {
        attachment.wire = createElement(
          "wire",
          fixed.x,
          fixed.y,
          reach.x,
          reach.y,
        );
        added.push(attachment.wire);
      }

      if (!corner) {
        attachment.bend = drop(attachment.bend);
      } else if (attachment.bend) {
        setEnds(attachment.bend, corner, target);
      } else {
        attachment.bend = createElement(
          "wire",
          corner.x,
          corner.y,
          target.x,
          target.y,
        );
        added.push(attachment.bend);
      }
    }

    return { added, removed };
  }

  /** The wires that were there and that the move shrank to a point, to delete. */
  collapsed() {
    return this.attachments.flatMap(({ wire, isNew }) =>
      wire && !isNew && isSamePoint(wire.start, wire.end) ? [wire] : [],
    );
  }
}
