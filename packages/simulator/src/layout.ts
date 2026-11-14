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
function boundsOf(points: readonly Point[], margin: number): Bounds {
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

/** Returns the box that an element's drawing roughly fills. */
function elementBounds(element: CircuitElement): Bounds {
  return boundsOf(extentPoints(element), element.bodyMargin());
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

function distanceToSegment(point: Point, a: Point, b: Point) {
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

  return Math.hypot(point.x - (a.x + along * dx), point.y - (a.y + along * dy));
}

/**
 * Returns how far `point` is from the element: from its line for two-post elements,
 * from its box (0 inside) for the rest.
 */
export function distanceToElement(element: CircuitElement, point: Point) {
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
