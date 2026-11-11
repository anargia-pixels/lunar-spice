import type { CircuitElement } from "@lunar-spice/simulator/element";

/** Spacing of the current dots along a path, in schematic units. */
export const DOT_SPACING = 16;

/** A frame at 60 frames a second; longer frames move the dots no further. */
const NOMINAL_FRAME_MS = 1000 / 60;

/** Share of a spacing the busiest path's dots move in a nominal frame. */
const MAX_STEP = DOT_SPACING / 4;

/** How long the largest current keeps setting the dot speed after it falls. */
const PEAK_DECAY_MS = 1000;

/** What the dots need of an element: the current along each path its symbol draws. */
type DottedElement = Pick<CircuitElement, "currentPaths">;

/**
 * Where each element's dots start along each of its paths (`currentPaths`). Every frame
 * moves them by the path's current, scaled to the largest current in the circuit, so the
 * dots stay visible whether it carries microamps or amps without a speed to set.
 */
export class CurrentDots {
  private offsets = new WeakMap<DottedElement, number[]>();

  /** The largest current lately, which sets how far a current moves its dots. */
  private peakCurrent = 0;

  /** Moves every element's dots by its path currents over `elapsedMs`. */
  advance(elements: readonly DottedElement[], elapsedMs: number) {
    const currents = elements.map((element) => element.currentPaths());

    const peak = Math.max(
      0,
      ...currents
        .flat()
        .map((current) => (Number.isFinite(current) ? Math.abs(current) : 0)),
    );

    this.peakCurrent = Math.max(
      peak,
      this.peakCurrent * Math.exp(-elapsedMs / PEAK_DECAY_MS),
    );

    if (this.peakCurrent <= 0) {
      return;
    }

    const frame = Math.min(elapsedMs, NOMINAL_FRAME_MS) / NOMINAL_FRAME_MS;

    elements.forEach((element, index) => {
      const offsets = this.offsets.get(element) ?? [];

      (currents[index] ?? []).forEach((current, path) => {
        // At most half a spacing per frame, so fast dots never look like they reverse.
        const step =
          ((current / this.peakCurrent) * MAX_STEP * frame) % (DOT_SPACING / 2);

        // Wrapped far out, so offsets stay small numbers without a visible jump.
        offsets[path] = ((offsets[path] ?? 0) + step) % (DOT_SPACING * 64);
      });
      this.offsets.set(element, offsets);
    });
  }

  /** Where each of an element's dots start, by path. */
  of(element: DottedElement): readonly number[] {
    return this.offsets.get(element) ?? [];
  }
}
