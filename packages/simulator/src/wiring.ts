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

/** True when `point` is on a wire between its ends, where a new wire's end would join. */
export function isOnWire(elements: readonly CircuitElement[], point: Point) {
  return elements.some(
    (element) => isWire(element) && positionOn(element, point) !== null,
  );
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
