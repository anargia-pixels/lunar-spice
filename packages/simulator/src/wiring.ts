import { cloneElement } from "./circuit";
import type { CircuitElement } from "./element";
import { type Point, pointKey } from "./geometry";

/** True for a wire: a conductor that only carries its net. */
function isWire(element: CircuitElement) {
  return element.isNetElement() && element.isConductor();
}

/**
 * Returns how far along `wire` the point lies, from 0 at its start to 1 at its end; null
 * unless the point is on the wire and between its ends.
 */
function positionOn(wire: CircuitElement, point: Point) {
  const dx = wire.x2 - wire.x1;
  const dy = wire.y2 - wire.y1;
  const px = point.x - wire.x1;
  const py = point.y - wire.y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0 || dx * py - dy * px !== 0) {
    return null;
  }

  const along = (px * dx + py * dy) / lengthSquared;

  return along > 0 && along < 1 ? along : null;
}

/** Returns the wire that runs through `point` between its ends, if any. */
export function wireThrough(elements: readonly CircuitElement[], point: Point) {
  return elements.find(
    (element) => isWire(element) && positionOn(element, point) !== null,
  );
}

/** True when `point` is on a wire between its ends, where a new wire's end would join. */
export function isOnWire(elements: readonly CircuitElement[], point: Point) {
  return wireThrough(elements, point) !== undefined;
}

/**
 * Joins every post that touches a wire between its ends: posts only join at the same
 * point, so the wire is cut there into pieces that end on the post. Wires that merely
 * cross stay apart. The first piece is the wire itself; the others follow it in the
 * returned list. Returns `elements` itself when no wire needs cutting.
 */
export function joinPostsToWires(elements: readonly CircuitElement[]) {
  const posts = new Map<string, Point>();

  for (const element of elements) {
    for (const post of element.posts()) {
      posts.set(pointKey(post), post);
    }
  }

  let hasCut = false;

  const joined = elements.flatMap((element) => {
    if (!isWire(element)) {
      return [element];
    }

    const cuts = [...posts.values()]
      .flatMap((point) => {
        const along = positionOn(element, point);

        return along === null ? [] : [{ point, along }];
      })
      .sort((a, b) => a.along - b.along);

    if (cuts.length === 0) {
      return [element];
    }

    hasCut = true;

    // Each piece runs from one cut to the next; the last one ends where the wire did.
    const stops = [...cuts.map(({ point }) => point), element.end];
    const pieces = [element];

    stops.forEach((stop, index) => {
      const from = stops[index - 1];

      if (!from) {
        element.x2 = stop.x;
        element.y2 = stop.y;

        return;
      }

      const piece = cloneElement(element);

      piece.x1 = from.x;
      piece.y1 = from.y;
      piece.x2 = stop.x;
      piece.y2 = stop.y;
      pieces.push(piece);
    });

    return pieces;
  });

  return hasCut ? joined : elements;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : greatestCommonDivisor(b, a % b);
}

/**
 * Names the straight line `wire` lies on, the same for every wire on that line; null for
 * a wire of no length or off whole units, which is left as it is.
 */
function lineOf(wire: CircuitElement) {
  const dx = wire.x2 - wire.x1;
  const dy = wire.y2 - wire.y1;
  const divisor = greatestCommonDivisor(dx, dy);

  if (
    divisor === 0 ||
    ![wire.x1, wire.y1, wire.x2, wire.y2].every(Number.isInteger)
  ) {
    return null;
  }

  // One direction per line, whichever way the wire was drawn.
  const sign = dx < 0 || (dx === 0 && dy < 0) ? -1 : 1;
  const direction = { x: (sign * dx) / divisor, y: (sign * dy) / divisor };

  return {
    key: `${direction.x},${direction.y},${direction.x * wire.y1 - direction.y * wire.x1}`,
    direction,
  };
}

/** A stretch of a line: its ends, with their positions along it. */
type Span = {
  from: Point;
  to: Point;
  fromAlong: number;
  toAlong: number;
};

/**
 * Combines wires that lie on one line and overlap or meet end to end into a single wire,
 * then cuts it again only where another post lands on it. Wires that meet with nothing
 * else at the joint become one, and a wire drawn over a longer one disappears into it;
 * the nets stay as they were. Returns `elements` itself when nothing changes.
 */
export function mergeWires(elements: readonly CircuitElement[]) {
  const lines = new Map<
    string,
    { direction: Point; wires: CircuitElement[] }
  >();

  for (const element of elements) {
    const line = isWire(element) ? lineOf(element) : null;

    if (line) {
      const group = lines.get(line.key) ?? {
        direction: line.direction,
        wires: [],
      };

      group.wires.push(element);
      lines.set(line.key, group);
    }
  }

  const removed = new Set<CircuitElement>();
  const added: CircuitElement[] = [];
  let hasChanged = false;

  for (const { direction, wires } of lines.values()) {
    if (wires.length < 2) {
      continue;
    }

    const along = (point: Point) =>
      point.x * direction.x + point.y * direction.y;

    const spanOf = (wire: CircuitElement): Span => {
      const [from, to] =
        along(wire.start) <= along(wire.end)
          ? [wire.start, wire.end]
          : [wire.end, wire.start];

      return { from, to, fromAlong: along(from), toAlong: along(to) };
    };

    const ordered = wires
      .map((wire) => ({ wire, span: spanOf(wire) }))
      .sort(
        (a, b) =>
          a.span.fromAlong - b.span.fromAlong ||
          a.span.toAlong - b.span.toAlong,
      );

    const first = ordered[0]?.wire;

    if (!first) {
      continue;
    }

    // Overlapping and touching wires run together into one stretch.
    const stretches: Span[] = [];

    for (const { span } of ordered) {
      const last = stretches.at(-1);

      if (last && span.fromAlong <= last.toAlong) {
        if (span.toAlong > last.toAlong) {
          last.to = span.to;
          last.toAlong = span.toAlong;
        }
      } else {
        stretches.push({ ...span });
      }
    }

    // Every post of another element that lands inside a stretch cuts it there.
    const own = new Set(wires);
    const { x1, y1 } = first;
    const cuts = new Map<string, Point>();

    for (const element of elements) {
      if (own.has(element)) {
        continue;
      }

      for (const post of element.posts()) {
        const onLine =
          (post.x - x1) * direction.y === (post.y - y1) * direction.x;

        if (onLine) {
          cuts.set(pointKey(post), post);
        }
      }
    }

    const spans = stretches.flatMap((stretch) => {
      const stops = [...cuts.values()]
        .filter((point) => {
          const position = along(point);

          return position > stretch.fromAlong && position < stretch.toAlong;
        })
        .sort((a, b) => along(a) - along(b));

      const ends = [stretch.from, ...stops, stretch.to];

      return ends.slice(1).map((to, index) => {
        const from = ends[index] ?? stretch.from;

        return { from, to, fromAlong: along(from), toAlong: along(to) };
      });
    });

    const isUnchanged =
      spans.length === ordered.length &&
      spans.every(
        (span, index) =>
          span.fromAlong === ordered[index]?.span.fromAlong &&
          span.toAlong === ordered[index]?.span.toAlong,
      );

    if (isUnchanged) {
      continue;
    }

    hasChanged = true;

    // The wires already there take the new spans in order, keeping the way each was
    // drawn; spare wires go, and a shortfall is made up with copies.
    spans.forEach((span, index) => {
      const existing = ordered[index]?.wire;
      const wire = existing ?? cloneElement(first);
      const isReversed = existing ? along(wire.start) > along(wire.end) : false;

      const [start, end] = isReversed
        ? [span.to, span.from]
        : [span.from, span.to];

      wire.x1 = start.x;
      wire.y1 = start.y;
      wire.x2 = end.x;
      wire.y2 = end.y;

      if (!existing) {
        added.push(wire);
      }
    });

    for (const { wire } of ordered.slice(spans.length)) {
      removed.add(wire);
    }
  }

  if (!hasChanged) {
    return elements;
  }

  return [...elements.filter((element) => !removed.has(element)), ...added];
}

/** The wires with an end at each point, and how many other posts each point has. */
function connectionsOf(elements: readonly CircuitElement[]) {
  const wireEnds = new Map<string, Set<CircuitElement>>();
  const otherPosts = new Map<string, number>();

  for (const element of elements) {
    if (isWire(element)) {
      for (const end of [element.start, element.end]) {
        const key = pointKey(end);
        const wires = wireEnds.get(key) ?? new Set();

        wires.add(element);
        wireEnds.set(key, wires);
      }
    } else {
      for (const post of element.posts()) {
        const key = pointKey(post);

        otherPosts.set(key, (otherPosts.get(key) ?? 0) + 1);
      }
    }
  }

  return { wireEnds, otherPosts };
}

/** The end of `wire` that is not `point`; its end when both are there. */
function otherEnd(wire: CircuitElement, point: Point) {
  return pointKey(wire.start) === pointKey(point) ? wire.end : wire.start;
}

/**
 * The wire `wire` is part of, as Multisim counts one: it and every wire that continues
 * it through a point where just two wire ends meet, so it runs from one pin, junction or
 * loose end to the next. In file order; a lone wire for anything else.
 */
export function wireRun(
  elements: readonly CircuitElement[],
  wire: CircuitElement,
) {
  if (!isWire(wire)) {
    return [wire];
  }

  const { wireEnds, otherPosts } = connectionsOf(elements);
  const run = new Set([wire]);
  const points = [wire.start, wire.end];

  for (let point = points.pop(); point; point = points.pop()) {
    const key = pointKey(point);
    const wires = [...(wireEnds.get(key) ?? [])];

    const isPassThrough =
      wires.length === 2 && !otherPosts.has(key) && !isOnWire(elements, point);

    const next = isPassThrough
      ? wires.find((other) => !run.has(other))
      : undefined;

    if (next) {
      run.add(next);
      points.push(otherEnd(next, point));
    }
  }

  return elements.filter((element) => run.has(element));
}

/**
 * Returns `elements` without `deleted` and without the wires deleting them leaves
 * hanging, as Multisim deletes a part's wires with it: a wire left with a loose end
 * where a deleted element had a post goes, and so on along its run, up to the first pin
 * or junction. A junction left with two wires becomes a bend in one wire; wires that
 * still join other parts stay.
 */
export function deleteWithWires(
  elements: readonly CircuitElement[],
  deleted: ReadonlySet<CircuitElement>,
) {
  const removed = new Set(deleted);

  const { wireEnds, otherPosts } = connectionsOf(
    elements.filter((element) => !removed.has(element)),
  );

  const points = [...deleted].flatMap((element) =>
    isWire(element) ? [element.start, element.end] : element.posts(),
  );

  for (let point = points.pop(); point; point = points.pop()) {
    const key = pointKey(point);
    const [wire, ...others] = wireEnds.get(key) ?? [];

    const isLoose =
      wire !== undefined &&
      others.length === 0 &&
      !otherPosts.has(key) &&
      !isOnWire(
        elements.filter((element) => !removed.has(element)),
        point,
      );

    if (wire && isLoose) {
      removed.add(wire);

      for (const end of [wire.start, wire.end]) {
        wireEnds.get(pointKey(end))?.delete(wire);
      }

      points.push(otherEnd(wire, point));
    }
  }

  return elements.filter((element) => !removed.has(element));
}
