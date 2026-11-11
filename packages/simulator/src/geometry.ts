/** A point on the schematic, in grid-aligned schematic units. */
export type Point = {
  x: number;
  y: number;
};

/** Spacing of the schematic grid; every post sits on it. */
export const GRID_SIZE = 16;

/** Returns a map key for a point; posts at the same spot get the same key. */
export function pointKey(point: Point) {
  return `${point.x},${point.y}`;
}

export function distance(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Rounds a coordinate to the nearest grid line. */
export function snapToGrid(value: number) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/**
 * Returns the point a fraction `along` the way from `a` to `b`, moved `across` units to
 * the left of the line (as drawn on screen, with y pointing down).
 */
export function interpolate(a: Point, b: Point, along: number, across = 0) {
  const length = distance(a, b) || 1;
  const normalX = (b.y - a.y) / length;
  const normalY = (a.x - b.x) / length;

  return {
    x: a.x + (b.x - a.x) * along + normalX * across,
    y: a.y + (b.y - a.y) * along + normalY * across,
  };
}

/** Returns the two points `across` units each side of the line, `along` the way. */
export function interpolatePair(
  a: Point,
  b: Point,
  along: number,
  across: number,
): [Point, Point] {
  return [interpolate(a, b, along, across), interpolate(a, b, along, -across)];
}

/** Rounds a point to whole units, so that posts at the same spot join exactly. */
export function roundPoint(point: Point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/**
 * Falstad's direction sign for an element from `a` to `b`: the sign of the vertical
 * extent, or of the horizontal extent for a horizontal element. Transistors and op-amps
 * use it to decide which side their extra posts sit on.
 */
export function directionSign(a: Point, b: Point) {
  const dy = b.y - a.y;

  return dy === 0 ? Math.sign(b.x - a.x) || 1 : Math.sign(dy);
}
