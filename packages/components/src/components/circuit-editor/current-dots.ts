import type { CircuitElement } from "@lunar-spice/simulator/element";

/** Spacing of the current dots along a path, in schematic units. */
export const DOT_SPACING = 16;

/** Longest frame the dots move for, so they do not leap after a stall. */
const MAX_FRAME_MS = 50;

/**
 * Where each element's dots start along each of its paths (`currentPaths`). Every frame
 * moves them by the path's current, at Falstad's dot speed for the current speed slider.
 */
export class CurrentDots {
  private offsets = new WeakMap<CircuitElement, number[]>();

  /** Moves every element's dots by its path currents over `elapsedMs`. */
  advance(
    elements: readonly CircuitElement[],
    elapsedMs: number,
    currentSpeed: number,
  ) {
    const multiplier =
      1.7 *
      Math.min(elapsedMs, MAX_FRAME_MS) *
      Math.exp(currentSpeed / 3.5 - 14.2);

    for (const element of elements) {
      const offsets = this.offsets.get(element) ?? [];

      element.currentPaths().forEach((current, path) => {
        // At most half a spacing per frame, so fast dots never look like they reverse.
        const step = (current * multiplier) % (DOT_SPACING / 2);

        // Wrapped far out, so offsets stay small numbers without a visible jump.
        offsets[path] = ((offsets[path] ?? 0) + step) % (DOT_SPACING * 64);
      });
      this.offsets.set(element, offsets);
    }
  }

  /** Where each of an element's dots start, by path. */
  of(element: CircuitElement): readonly number[] {
    return this.offsets.get(element) ?? [];
  }
}
