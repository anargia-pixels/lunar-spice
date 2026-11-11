const MINUTE_MS = 60_000;

/** Largest unit first; each label applies once the elapsed time reaches its size. */
const UNITS = [
  { sizeMs: 365 * 24 * 60 * MINUTE_MS, suffix: "y" },
  { sizeMs: 30 * 24 * 60 * MINUTE_MS, suffix: "mo" },
  { sizeMs: 7 * 24 * 60 * MINUTE_MS, suffix: "w" },
  { sizeMs: 24 * 60 * MINUTE_MS, suffix: "d" },
  { sizeMs: 60 * MINUTE_MS, suffix: "h" },
  { sizeMs: MINUTE_MS, suffix: "m" },
] as const;

/** Compact time since `timeMs`, such as `17m ago`, `2d ago` or `1w ago`. */
export function formatTimeAgo(timeMs: number, nowMs: number) {
  const elapsedMs = Math.max(0, nowMs - timeMs);
  const unit = UNITS.find(({ sizeMs }) => elapsedMs >= sizeMs);

  return unit
    ? `${Math.floor(elapsedMs / unit.sizeMs)}${unit.suffix} ago`
    : "now";
}
