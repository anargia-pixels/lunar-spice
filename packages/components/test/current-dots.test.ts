import { describe, expect, test } from "bun:test";

import {
  CurrentDots,
  DOT_SPACING,
} from "../src/components/circuit-editor/current-dots";

/** A frame at 60 frames a second, which sets the dot speed. */
const FRAME_MS = 1000 / 60;

/** An element that reports the given currents, one per path. */
function element(currents: number[]) {
  return { currentPaths: () => currents };
}

/** The offsets after one frame carrying `currents`. */
function advanceOnce(currents: number[], frameMs = FRAME_MS) {
  const dots = new CurrentDots();
  const parts = currents.map((current) => element([current]));

  dots.advance(parts, frameMs);

  return parts.map((part) => dots.of(part)[0] ?? 0);
}

describe("current dots", () => {
  test("the busiest path moves a quarter of a spacing a frame", () => {
    expect(advanceOnce([1])).toEqual([DOT_SPACING / 4]);
  });

  test("scales the other paths to the busiest current", () => {
    const [busiest, half, none] = advanceOnce([1, 0.5, 0]);

    expect(busiest).toBe(DOT_SPACING / 4);
    expect(half).toBe(DOT_SPACING / 8);
    expect(none).toBe(0);
  });

  test("keeps microamps moving like amps, with no speed to set", () => {
    expect(advanceOnce([1e-6])).toEqual([DOT_SPACING / 4]);
  });

  test("stays still without current", () => {
    expect(advanceOnce([0])).toEqual([0]);
  });

  test("moves no further when a frame runs long", () => {
    expect(advanceOnce([1], 500)).toEqual(advanceOnce([1]));
  });
});
