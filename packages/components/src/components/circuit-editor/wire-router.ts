import type { CircuitElement } from "@lunar-spice/simulator/element";
import { GRID_SIZE, type Point } from "@lunar-spice/simulator/geometry";

export type Axis = "horizontal" | "vertical";

/** A stretch of a row or column, from the lower coordinate to the higher. */
type Span = readonly [number, number];

/** What a part's drawing covers: a box, or the line between in-line posts. */
type Body = { left: number; top: number; right: number; bottom: number };

/** Grid steps the search may stray beyond the box around a route's two ends. */
const SEARCH_MARGIN = 6;

/** What one grid step costs in the search, leaving room below it for tie-breaks. */
const STEP_COST = 1024;

/** What a bend costs, two grid steps, so a route takes few of them. */
const BEND_COST = 2 * STEP_COST;

/** What a step over a part's drawing costs, so a route goes around parts. */
const BODY_COST = 40 * STEP_COST;

/**
 * The most a bend's lateness adds to its cost. Of routes that cost the same, the one
 * that bends nearest where it starts wins, which keeps the space by the moved part's
 * pins free for the wires that come after it.
 */
const LATE_BEND_COST = 63;

/** The most steps the search tries before it gives up. */
const SEARCH_LIMIT = 40_000;

/** The four ways a step goes, as grid offsets. */
const DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const;

function isSamePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function isWire(element: CircuitElement) {
  return element.isNetElement() && element.isConductor();
}

function add(map: Map<number, number[]>, line: number, at: number) {
  const list = map.get(line) ?? [];

  list.push(at);
  map.set(line, list);
}

/** True when the open stretches (a0, a1) and (b0, b1) share some length. */
function overlaps(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(a0, b0) < Math.min(a1, b1);
}

/**
 * The line a straight horizontal or vertical stretch from `a` to `b` lies on, and its
 * extent along that line, lowest first; null for a slanted one.
 */
function lineOf(a: Point, b: Point) {
  if (a.y === b.y) {
    return {
      isRow: true,
      line: a.y,
      from: Math.min(a.x, b.x),
      to: Math.max(a.x, b.x),
    };
  }

  if (a.x === b.x) {
    return {
      isRow: false,
      line: a.x,
      from: Math.min(a.y, b.y),
      to: Math.max(a.y, b.y),
    };
  }

  return null;
}

/**
 * What a wire being routed must keep clear of, as the editor would otherwise join it to
 * the wrong net: posts, which a wire passing over would join, and the wires there,
 * which a wire running along or turning on would join too. Parts' drawings are to be
 * avoided as well, though crossing one joins nothing.
 */
export class RouteObstacles {
  private readonly postsByRow = new Map<number, number[]>();
  private readonly postsByColumn = new Map<number, number[]>();
  private readonly rows = new Map<number, Span[]>();
  private readonly columns = new Map<number, Span[]>();
  private readonly bodies: Body[] = [];

  constructor(elements: readonly CircuitElement[]) {
    for (const element of elements) {
      if (isWire(element)) {
        this.addWire(element.start, element.end);
        continue;
      }

      const posts = element.posts();

      for (const post of posts) {
        this.addPost(post);
      }

      if (
        posts.length >= 2 &&
        !element.isStretchable() &&
        !element.isEnclosure()
      ) {
        const points = [...posts, ...(element.bodyOutline() ?? [])];
        const xs = points.map(({ x }) => x);
        const ys = points.map(({ y }) => y);

        this.bodies.push({
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        });
      }
    }
  }

  addPost(point: Point) {
    add(this.postsByRow, point.y, point.x);
    add(this.postsByColumn, point.x, point.y);
  }

  /** Adds a wire: its ends are posts, and its length is not to be run along. */
  addWire(start: Point, end: Point) {
    this.addPost(start);
    this.addPost(end);

    const line = lineOf(start, end);

    if (!line || line.from === line.to) {
      return;
    }

    const spans = line.isRow ? this.rows : this.columns;
    const list = spans.get(line.line) ?? [];

    list.push([line.from, line.to]);
    spans.set(line.line, list);
  }

  /**
   * True when a post lies on the straight stretch from `a` to `b`: between them, or at
   * `b` unless `isEndFree`. `a` is where the route already is, so it is never counted.
   */
  hasPostOn(a: Point, b: Point, isEndFree: boolean) {
    const line = lineOf(a, b);

    if (!line) {
      return false;
    }

    const along = (line.isRow ? this.postsByRow : this.postsByColumn).get(
      line.line,
    );

    const start = line.isRow ? a.x : a.y;
    const end = line.isRow ? b.x : b.y;

    return (along ?? []).some(
      (at) =>
        at !== start &&
        at >= line.from &&
        at <= line.to &&
        !(isEndFree && at === end),
    );
  }

  /** True when the stretch from `a` to `b` runs along part of a wire. */
  runsAlongWire(a: Point, b: Point) {
    const line = lineOf(a, b);

    if (!line) {
      return false;
    }

    const spans = (line.isRow ? this.rows : this.columns).get(line.line) ?? [];

    return spans.some(([from, to]) => overlaps(line.from, line.to, from, to));
  }

  /** True when `point` is on a wire between its ends, where a wire turning there joins it. */
  isOnWire(point: Point) {
    const inRow = (this.rows.get(point.y) ?? []).some(
      ([from, to]) => from < point.x && point.x < to,
    );

    return (
      inRow ||
      (this.columns.get(point.x) ?? []).some(
        ([from, to]) => from < point.y && point.y < to,
      )
    );
  }

  /**
   * How many parts' drawings the stretch from `a` to `b` runs over: inside a part's box
   * or along its edge, or along or across the line between an in-line part's posts.
   */
  bodiesCrossed(a: Point, b: Point) {
    const line = lineOf(a, b);

    if (!line) {
      return 0;
    }

    return this.bodies.filter((body) => {
      // Along the stretch's line, then across it.
      const [low, high, acrossLow, acrossHigh] = line.isRow
        ? [body.left, body.right, body.top, body.bottom]
        : [body.top, body.bottom, body.left, body.right];

      const isFlat = acrossLow === acrossHigh;
      const isUpright = low === high;

      if (isFlat && isUpright) {
        return false;
      }

      // An in-line part on the stretch's line: running along it between its posts.
      if (isFlat) {
        return (
          line.line === acrossLow && overlaps(line.from, line.to, low, high)
        );
      }

      // An in-line part across the line: reaching it between its posts.
      if (isUpright) {
        return (
          line.line > acrossLow &&
          line.line < acrossHigh &&
          low >= line.from &&
          low <= line.to
        );
      }

      // A box: inside it or along its edge, where a wire would seem to join the posts
      // on that edge. Reaching a post on the edge from outside is fine.
      return (
        line.line >= acrossLow &&
        line.line <= acrossHigh &&
        overlaps(line.from, line.to, low, high)
      );
    }).length;
  }
}

/** The stretches of a route, each as its two ends, with whether it is the last. */
function stretchesOf(route: readonly Point[]) {
  return route.slice(1).map((to, index) => ({
    from: route[index] ?? to,
    to,
    isLast: index === route.length - 2,
  }));
}

/**
 * How many parts' drawings `route` runs over; null when it would join something it
 * should not, by passing over a post, running along a wire or turning on one.
 */
function crossingsOf(route: readonly Point[], obstacles: RouteObstacles) {
  let crossings = 0;

  for (const { from, to, isLast } of stretchesOf(route)) {
    if (
      obstacles.hasPostOn(from, to, isLast) ||
      obstacles.runsAlongWire(from, to) ||
      (!isLast && obstacles.isOnWire(to))
    ) {
      return null;
    }

    crossings += obstacles.bodiesCrossed(from, to);
  }

  return crossings;
}

/** `points` with only its ends and its bends, where the way it runs changes. */
function bendsOf(points: readonly Point[]) {
  return points.filter((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];

    if (!before || !after) {
      return true;
    }

    const isStraight =
      (before.x === point.x && point.x === after.x) ||
      (before.y === point.y && point.y === after.y);

    return !isStraight;
  });
}

/**
 * The cheapest route from `from` to `to` along the grid, by Dijkstra's search over grid
 * points and the way the route arrived: each grid step costs `STEP_COST`, each bend
 * `BEND_COST` and a little more the later it comes, and each step over a part
 * `BODY_COST`. It leaves along `axis` when that costs no more. Null when the ends are off one grid, the area is too large to search,
 * or nothing clear reaches `to`.
 */
function searchRoute(
  from: Point,
  to: Point,
  axis: Axis | null,
  obstacles: RouteObstacles,
) {
  const goalX = (to.x - from.x) / GRID_SIZE;
  const goalY = (to.y - from.y) / GRID_SIZE;

  if (!Number.isInteger(goalX) || !Number.isInteger(goalY)) {
    return null;
  }

  const left = Math.min(0, goalX) - SEARCH_MARGIN;
  const top = Math.min(0, goalY) - SEARCH_MARGIN;
  const width = Math.max(0, goalX) + SEARCH_MARGIN - left + 1;
  const height = Math.max(0, goalY) + SEARCH_MARGIN - top + 1;
  const states = width * height * DIRECTIONS.length;

  if (states > SEARCH_LIMIT * DIRECTIONS.length) {
    return null;
  }

  const costs = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(states).fill(-1);
  const stepsTo = new Int32Array(states);
  const queue: number[][] = [];

  const pointAt = (x: number, y: number) => ({
    x: from.x + x * GRID_SIZE,
    y: from.y + y * GRID_SIZE,
  });

  const stateOf = (x: number, y: number, direction: number) =>
    ((y - top) * width + (x - left)) * DIRECTIONS.length + direction;

  const cellOf = (state: number) => {
    const cell = Math.floor(state / DIRECTIONS.length);

    return { x: (cell % width) + left, y: Math.floor(cell / width) + top };
  };

  /** Tries a step from grid point (`x`, `y`), reached heading `heading` (-1 at the start). */
  const tryStep = (
    x: number,
    y: number,
    heading: number,
    direction: number,
    cost: number,
    state: number,
  ) => {
    const offset = DIRECTIONS[direction];

    if (!offset) {
      return;
    }

    const nextX = x + offset.x;
    const nextY = y + offset.y;

    if (
      nextX < left ||
      nextX >= left + width ||
      nextY < top ||
      nextY >= top + height
    ) {
      return;
    }

    const here = pointAt(x, y);
    const there = pointAt(nextX, nextY);
    const isGoal = nextX === goalX && nextY === goalY;
    const isBend = heading !== -1 && heading !== direction;

    if (
      (isBend && obstacles.isOnWire(here)) ||
      obstacles.hasPostOn(here, there, isGoal) ||
      obstacles.runsAlongWire(here, there)
    ) {
      return;
    }

    const steps = state === -1 ? 0 : (stepsTo[state] ?? 0);

    const next =
      cost +
      STEP_COST +
      (isBend ? BEND_COST + Math.min(steps, LATE_BEND_COST) : 0) +
      obstacles.bodiesCrossed(here, there) * BODY_COST;

    const nextState = stateOf(nextX, nextY, direction);

    if (next < (costs[nextState] ?? 0)) {
      costs[nextState] = next;
      previous[nextState] = state;
      stepsTo[nextState] = steps + 1;
      (queue[next] ??= []).push(nextState);
    }
  };

  // The first step goes along `axis` first, so it wins a tie.
  const firstSteps = axis === "vertical" ? [2, 3, 0, 1] : [0, 1, 2, 3];

  for (const direction of firstSteps) {
    tryStep(0, 0, -1, direction, 0, -1);
  }

  let tried = 0;

  for (let cost = 0; cost < queue.length; cost += 1) {
    for (const state of queue[cost] ?? []) {
      if (costs[state] !== cost) {
        continue;
      }

      tried += 1;

      if (tried > SEARCH_LIMIT) {
        return null;
      }

      const heading = state % DIRECTIONS.length;
      const { x, y } = cellOf(state);

      if (x === goalX && y === goalY) {
        const points: Point[] = [];

        for (let at = state; at !== -1; at = previous[at] ?? -1) {
          const cell = cellOf(at);

          points.push(pointAt(cell.x, cell.y));
        }

        points.push(from);

        return bendsOf(points.reverse());
      }

      const ahead = DIRECTIONS[heading] ?? { x: 0, y: 0 };

      for (const [direction, offset] of DIRECTIONS.entries()) {
        // A route never doubles back over itself.
        if (offset.x !== -ahead.x || offset.y !== -ahead.y) {
          tryStep(x, y, heading, direction, cost, state);
        }
      }
    }
  }

  return null;
}

/** The straight route from `from` to `to`, or the two with one bend, `axis` first. */
function directRoutes(from: Point, to: Point, axis: Axis | null) {
  if (from.x === to.x || from.y === to.y) {
    return [[from, to]];
  }

  const sideways = [from, { x: to.x, y: from.y }, to];
  const upright = [from, { x: from.x, y: to.y }, to];

  return axis === "vertical" ? [upright, sideways] : [sideways, upright];
}

/**
 * Routes a wire from `from` to `to` on the grid, as Multisim reroutes a wire whose pin
 * moved: straight, or with one bend leaving along `axis` when that is clear, else
 * around whatever is in the way with the fewest bends. Clear means it joins nothing it
 * should not and runs over no part. Returns the route's ends and bends; just `from`
 * when the two are the same point.
 */
export function routeWire(
  from: Point,
  to: Point,
  axis: Axis | null,
  obstacles: RouteObstacles,
): Point[] {
  if (isSamePoint(from, to)) {
    return [from];
  }

  const direct = directRoutes(from, to, axis);
  const crossings = direct.map((route) => crossingsOf(route, obstacles));
  const clear = direct.find((_route, index) => crossings[index] === 0);

  if (clear) {
    return clear;
  }

  return (
    searchRoute(from, to, axis, obstacles) ??
    direct.find((_route, index) => crossings[index] !== null) ??
    direct[0] ?? [from, to]
  );
}
