/**
 * Plot trace colors, in their fixed order. Each class names a `--trace-N` token in
 * globals.css; the classes are written out whole so Tailwind keeps them.
 */
const TRACE_SWATCHES = [
  "bg-trace-1",
  "bg-trace-2",
  "bg-trace-3",
  "bg-trace-4",
  "bg-trace-5",
  "bg-trace-6",
  "bg-trace-7",
  "bg-trace-8",
] as const;

/** How many traces fit on one plot before a color would repeat. */
export const TRACE_COUNT = TRACE_SWATCHES.length;

/** The background class for trace color slot `slot`. */
export function traceSwatch(slot: number) {
  return TRACE_SWATCHES[slot % TRACE_COUNT];
}
