import type { CircuitElement } from "./element";
import { type Point, snapToGrid } from "./geometry";

/** An axis-aligned box in schematic units. */
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Returns the box around `points`, grown by `margin` on each side. */
export function boundsOf(points: readonly Point[], margin: number): Bounds {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);

  return {
    left: Math.min(...xs) - margin,
    top: Math.min(...ys) - margin,
    right: Math.max(...xs) + margin,
    bottom: Math.max(...ys) + margin,
  };
}

/** Returns an element's start, end and posts: the points its drawing spans. */
function extentPoints(element: CircuitElement) {
  return [element.start, element.end, ...element.posts()];
}

/** Returns the box that an element's drawing fills: its outline's, or else a rough one. */
function elementBounds(element: CircuitElement): Bounds {
  const outline = element.bodyOutline();

  return outline === null
    ? boundsOf(extentPoints(element), element.bodyMargin())
    : boundsOf([...extentPoints(element), ...outline], 0);
}

/** Returns the box around every element's drawing, or null for an empty list. */
export function boundsOfElements(elements: readonly CircuitElement[]) {
  if (elements.length === 0) {
    return null;
  }

  const boxes = elements.map(elementBounds);

  return {
    left: Math.min(...boxes.map(({ left }) => left)),
    top: Math.min(...boxes.map(({ top }) => top)),
    right: Math.max(...boxes.map(({ right }) => right)),
    bottom: Math.max(...boxes.map(({ bottom }) => bottom)),
  };
}

/** Returns the point of the segment from `a` to `b` nearest `point`. */
function nearestOnSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  const along =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
          ),
        );

  return { x: a.x + along * dx, y: a.y + along * dy };
}

function distanceToSegment(point: Point, a: Point, b: Point) {
  const nearest = nearestOnSegment(point, a, b);

  return Math.hypot(point.x - nearest.x, point.y - nearest.y);
}

/** Returns the edges of the polygon `outline`, each as its two corners. */
function edgesOf(outline: readonly Point[]) {
  return outline.map(
    (corner, index) =>
      [corner, outline[(index + 1) % outline.length] ?? corner] as const,
  );
}

/** True when `point` lies inside the polygon `outline`, by counting edges crossed. */
function isInsideOutline(point: Point, outline: readonly Point[]) {
  let isInside = false;

  for (const [a, b] of edgesOf(outline)) {
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);

    if (crosses) {
      isInside = !isInside;
    }
  }

  return isInside;
}

/** Returns the point of the polygon `outline`'s edge nearest `point`. */
function nearestOnOutline(point: Point, outline: readonly Point[]) {
  let nearest = outline[0] ?? point;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const [a, b] of edgesOf(outline)) {
    const candidate = nearestOnSegment(point, a, b);

    const candidateDistance = Math.hypot(
      point.x - candidate.x,
      point.y - candidate.y,
    );

    if (candidateDistance < nearestDistance) {
      nearest = candidate;
      nearestDistance = candidateDistance;
    }
  }

  return nearest;
}

/**
 * Returns how far `point` is from a part drawn as `outline` with a lead from each of
 * its posts straight to the outline: 0 inside.
 */
function distanceToOutline(
  element: CircuitElement,
  outline: readonly Point[],
  point: Point,
) {
  if (isInsideOutline(point, outline)) {
    return 0;
  }

  const edge = nearestOnOutline(point, outline);
  let nearest = Math.hypot(point.x - edge.x, point.y - edge.y);

  for (const post of element.posts()) {
    const lead = nearestOnOutline(post, outline);

    nearest = Math.min(nearest, distanceToSegment(point, post, lead));
  }

  return nearest;
}

/** The corners of an enclosure's rectangle, clockwise from its start. */
function enclosureCorners({ start, end }: CircuitElement) {
  return [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
}

/**
 * Returns how far `point` is from the element: from its border for an enclosure, from
 * its line for two-post elements, from its outline and leads for parts that give one,
 * and from its box (0 inside) for the rest.
 */
export function distanceToElement(element: CircuitElement, point: Point) {
  if (element.isEnclosure()) {
    // Inside is open canvas, for picking and rubber bands among what it holds.
    const nearest = nearestOnOutline(point, enclosureCorners(element));

    return Math.hypot(point.x - nearest.x, point.y - nearest.y);
  }

  const outline = element.bodyOutline();

  if (outline !== null) {
    return distanceToOutline(element, outline, point);
  }

  if (element.posts().length <= 2) {
    return distanceToSegment(point, element.start, element.end);
  }

  const box = elementBounds(element);
  const dx = Math.max(box.left - point.x, 0, point.x - box.right);
  const dy = Math.max(box.top - point.y, 0, point.y - box.bottom);

  return Math.hypot(dx, dy);
}

/** True when an element's start, end and posts all lie inside `box`, for rubber-band selection. */
export function isInside(element: CircuitElement, box: Bounds) {
  return extentPoints(element).every(
    ({ x, y }) =>
      x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
  );
}

/**
 * Returns `elements` with everything inside each enclosure among them, such as a group's
 * parts, in the order of `all`. What an enclosure holds is whatever lies wholly inside
 * its rectangle.
 */
export function withEnclosed(
  elements: readonly CircuitElement[],
  all: readonly CircuitElement[],
) {
  const boxes = elements.flatMap((element) =>
    element.isEnclosure() ? [boundsOf([element.start, element.end], 0)] : [],
  );

  const chosen = new Set(elements);

  return all.filter(
    (element) =>
      chosen.has(element) || boxes.some((box) => isInside(element, box)),
  );
}

/** Returns the grid point nearest the middle of the elements' points. */
function pivotOf(elements: readonly CircuitElement[]) {
  const box = boundsOf(elements.flatMap(extentPoints), 0);

  return {
    x: snapToGrid((box.left + box.right) / 2),
    y: snapToGrid((box.top + box.bottom) / 2),
  };
}

/** Turns the elements a quarter turn about their middle; clockwise as seen on screen. */
export function rotateElements(
  elements: readonly CircuitElement[],
  isClockwise: boolean,
) {
  if (elements.length === 0) {
    return;
  }

  const pivot = pivotOf(elements);
  const sign = isClockwise ? 1 : -1;

  for (const element of elements) {
    element.transform(({ x, y }) => ({
      x: pivot.x - sign * (y - pivot.y),
      y: pivot.y + sign * (x - pivot.x),
    }));
  }
}

/** Mirrors the elements left to right (`horizontal`) or top to bottom about their middle. */
export function flipElements(
  elements: readonly CircuitElement[],
  axis: "horizontal" | "vertical",
) {
  if (elements.length === 0) {
    return;
  }

  const pivot = pivotOf(elements);

  for (const element of elements) {
    element.transform(({ x, y }) =>
      axis === "horizontal"
        ? { x: 2 * pivot.x - x, y }
        : { x, y: 2 * pivot.y - y },
    );
  }
}

/** Returns the top-left corner of the elements' points, without the margin; null for none. */
export function cornerOfElements(elements: readonly CircuitElement[]) {
  if (elements.length === 0) {
    return null;
  }

  const box = boundsOf(elements.flatMap(extentPoints), 0);

  return { x: box.left, y: box.top };
}
