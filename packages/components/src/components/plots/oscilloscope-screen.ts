import {
  HORIZONTAL_DIVISIONS,
  type OscilloscopeSettings,
  VERTICAL_DIVISIONS,
} from "@lunar-spice/simulator/elements/oscilloscope";

import {
  type CanvasPalette,
  rgbText,
  traceColor,
} from "../../lib/canvas-palette";
import type { OscilloscopeTrace } from "../../lib/oscilloscope";

/** What the cursors measure: nothing, time between two vertical lines, or voltage. */
export const CURSOR_MODES = ["off", "time", "voltage"] as const;

export type CursorMode = (typeof CURSOR_MODES)[number];

/** Where the two cursors sit, in divisions, so they stay put when a scale changes. */
export type Cursors = {
  mode: CursorMode;
  /** The channel voltage cursors read in. */
  channel: number;
  /** Divisions from the screen's left edge. */
  times: readonly [number, number];
  /** Divisions above the screen's middle. */
  levels: readonly [number, number];
};

/** Room around the graticule for the channel and trigger markers, in CSS pixels. */
const INSET = { x: 14, y: 8 };

/** Minor ticks per division on the middle lines. */
const TICKS_PER_DIVISION = 5;

/** Half a marker's height, in CSS pixels. */
const MARKER = 5;

/** The graticule's place on a canvas `width` by `height` CSS pixels. */
export function graticule(width: number, height: number) {
  const left = INSET.x;
  const top = INSET.y;
  const right = Math.max(left + 1, width - INSET.x);
  const bottom = Math.max(top + 1, height - INSET.y);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    division: {
      x: (right - left) / HORIZONTAL_DIVISIONS,
      y: (bottom - top) / VERTICAL_DIVISIONS,
    },
  };
}

export type Graticule = ReturnType<typeof graticule>;

/**
 * The time at the screen's left edge: the trigger sits `position` divisions right of
 * the middle; an untriggered trace ends at the right edge.
 */
export function screenStart(
  trace: OscilloscopeTrace,
  settings: OscilloscopeSettings,
) {
  const { secondsPerDivision, position } = settings;

  return trace.triggerTime === null
    ? trace.end - HORIZONTAL_DIVISIONS * secondsPerDivision
    : trace.triggerTime -
        (HORIZONTAL_DIVISIONS / 2 + position) * secondsPerDivision;
}

/** The divisions from the left edge where times count from: the trigger point. */
export function triggerDivision(settings: OscilloscopeSettings) {
  return HORIZONTAL_DIVISIONS / 2 + settings.position;
}

/** Divisions above the middle where channel `channel` draws `voltage`. */
export function divisionsOf(
  settings: OscilloscopeSettings,
  channel: number,
  voltage: number,
) {
  const { voltsPerDivision = 1, position = 0 } =
    settings.channels[channel] ?? {};

  return voltage / voltsPerDivision + position;
}

/** The voltage of channel `channel` at `divisions` above the middle. */
export function voltageAt(
  settings: OscilloscopeSettings,
  channel: number,
  divisions: number,
) {
  const { voltsPerDivision = 1, position = 0 } =
    settings.channels[channel] ?? {};

  return (divisions - position) * voltsPerDivision;
}

/** The y pixel of `divisions` above the middle. */
function yOf(grid: Graticule, divisions: number) {
  return grid.top + grid.height / 2 - divisions * grid.division.y;
}

/** The divisions grid, dotted, with ticked middle lines. */
function drawGraticule(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  grid: Graticule,
) {
  const { left, top, width, height, division } = grid;
  const middleX = left + width / 2;
  const middleY = top + height / 2;

  context.lineWidth = 1;
  context.strokeStyle = palette.border;
  context.setLineDash([1, 3]);
  context.beginPath();

  for (let column = 1; column < HORIZONTAL_DIVISIONS; column += 1) {
    const x = Math.round(left + column * division.x) + 0.5;

    context.moveTo(x, top);
    context.lineTo(x, top + height);
  }

  for (let row = 1; row < VERTICAL_DIVISIONS; row += 1) {
    const y = Math.round(top + row * division.y) + 0.5;

    context.moveTo(left, y);
    context.lineTo(left + width, y);
  }

  context.stroke();
  context.setLineDash([]);
  context.strokeStyle = rgbText(palette.muted, 0.6);
  context.strokeRect(
    Math.round(left) + 0.5,
    Math.round(top) + 0.5,
    Math.round(width),
    Math.round(height),
  );

  // Ticks every fifth of a division along both middle lines.
  context.beginPath();

  for (
    let tick = 1;
    tick < HORIZONTAL_DIVISIONS * TICKS_PER_DIVISION;
    tick += 1
  ) {
    const x = Math.round(left + (tick * division.x) / TICKS_PER_DIVISION) + 0.5;

    context.moveTo(x, middleY - 3);
    context.lineTo(x, middleY + 3);
  }

  for (
    let tick = 1;
    tick < VERTICAL_DIVISIONS * TICKS_PER_DIVISION;
    tick += 1
  ) {
    const y = Math.round(top + (tick * division.y) / TICKS_PER_DIVISION) + 0.5;

    context.moveTo(middleX - 3, y);
    context.lineTo(middleX + 3, y);
  }

  context.stroke();
}

/** Each channel that is on, as a line through every bucket's two extremes. */
function drawTraces(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  grid: Graticule,
  settings: OscilloscopeSettings,
  trace: OscilloscopeTrace,
) {
  const start = screenStart(trace, settings);
  const pixelsPerSecond = grid.division.x / settings.secondsPerDivision;

  context.save();
  context.beginPath();
  context.rect(grid.left, grid.top, grid.width, grid.height);
  context.clip();
  context.lineWidth = 1.5;
  context.lineJoin = "round";

  settings.channels.forEach((channel, index) => {
    const data = trace.channels[index];

    if (!channel.isOn || !data || trace.count === 0) {
      return;
    }

    context.strokeStyle = traceColor(palette, index);
    context.beginPath();

    for (let bucket = 0; bucket < trace.count; bucket += 1) {
      const time = trace.firstEnd + bucket * trace.bucketTime;
      const x = grid.left + (time - start) * pixelsPerSecond;

      for (let entry = 0; entry < 2; entry += 1) {
        const value = data.extremes[2 * bucket + entry] ?? 0;
        const y = yOf(grid, divisionsOf(settings, index, value));

        if (bucket === 0 && entry === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
    }

    context.stroke();
  });

  context.restore();
}

/** A filled marker pointing `direction` with `label` on it, at the tip `x`, `y`. */
function drawMarker(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  { x, y }: { x: number; y: number },
  direction: "right" | "left" | "down",
  color: string,
  label: string,
) {
  const length = 2 * MARKER + 2;

  context.fillStyle = color;
  context.beginPath();

  if (direction === "down") {
    context.moveTo(x, y);
    context.lineTo(x - MARKER, y - MARKER);
    context.lineTo(x - MARKER, y - length);
    context.lineTo(x + MARKER, y - length);
    context.lineTo(x + MARKER, y - MARKER);
  } else {
    const sign = direction === "right" ? -1 : 1;

    context.moveTo(x, y);
    context.lineTo(x + sign * MARKER, y - MARKER);
    context.lineTo(x + sign * length, y - MARKER);
    context.lineTo(x + sign * length, y + MARKER);
    context.lineTo(x + sign * MARKER, y + MARKER);
  }

  context.closePath();
  context.fill();
  context.fillStyle = palette.card;
  context.font = `bold 8px ${palette.codeFontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const center =
    direction === "down"
      ? { x, y: y - MARKER - 1 - MARKER / 2 }
      : {
          x: x + (direction === "right" ? -1 : 1) * (MARKER + 1 + MARKER / 2),
          y,
        };

  context.fillText(label, center.x, center.y + 0.5);
}

/**
 * The markers around the graticule: each channel's 0 V on the left, the trigger level
 * on the right in its source's color, and the trigger point along the top.
 */
function drawMarkers(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  grid: Graticule,
  settings: OscilloscopeSettings,
) {
  const clampY = (y: number) =>
    Math.min(grid.top + grid.height, Math.max(grid.top, y));

  settings.channels.forEach((channel, index) => {
    if (channel.isOn) {
      drawMarker(
        context,
        palette,
        { x: grid.left - 1, y: clampY(yOf(grid, channel.position)) },
        "right",
        traceColor(palette, index),
        String(index + 1),
      );
    }
  });

  const source = settings.triggerSource;

  drawMarker(
    context,
    palette,
    {
      x: grid.left + grid.width + 1,
      y: clampY(
        yOf(grid, divisionsOf(settings, source, settings.triggerLevel)),
      ),
    },
    "left",
    traceColor(palette, source),
    "T",
  );
  drawMarker(
    context,
    palette,
    {
      x: grid.left + triggerDivision(settings) * grid.division.x,
      y: grid.top + MARKER + 1,
    },
    "down",
    rgbText(palette.foreground, 0.7),
    "T",
  );
}

/** The two cursors as dashed lines across the screen, each named at its end. */
function drawCursors(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  grid: Graticule,
  cursors: Cursors,
) {
  if (cursors.mode === "off") {
    return;
  }

  const color =
    cursors.mode === "voltage"
      ? traceColor(palette, cursors.channel)
      : rgbText(palette.foreground, 0.8);

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  context.font = `10px ${palette.codeFontFamily}`;
  context.textBaseline = "top";

  const isTime = cursors.mode === "time";
  const positions = isTime ? cursors.times : cursors.levels;

  positions.forEach((position, index) => {
    context.beginPath();

    if (isTime) {
      const x = Math.round(grid.left + position * grid.division.x) + 0.5;

      context.moveTo(x, grid.top);
      context.lineTo(x, grid.top + grid.height);
      context.stroke();
      context.textAlign = "left";
      context.fillText(`X${index + 1}`, x + 3, grid.top + 2 * MARKER + 6);
    } else {
      const y = Math.round(yOf(grid, position)) + 0.5;

      context.moveTo(grid.left, y);
      context.lineTo(grid.left + grid.width, y);
      context.stroke();
      context.textAlign = "right";
      context.fillText(`Y${index + 1}`, grid.left + grid.width - 4, y + 3);
    }
  });

  context.restore();
}

/** Draws the whole screen onto a context scaled to CSS pixels. */
export function drawScreen(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  size: { width: number; height: number },
  settings: OscilloscopeSettings,
  trace: OscilloscopeTrace | null,
  cursors: Cursors,
) {
  const grid = graticule(size.width, size.height);

  context.clearRect(0, 0, size.width, size.height);
  drawGraticule(context, palette, grid);

  if (trace) {
    drawTraces(context, palette, grid, settings, trace);
  }

  drawCursors(context, palette, grid, cursors);
  drawMarkers(context, palette, grid, settings);
}

/** The cursor nearest a pointer at `x`, `y` on the screen, and where it would move to. */
export function cursorAt(
  grid: Graticule,
  cursors: Cursors,
  x: number,
  y: number,
) {
  if (cursors.mode === "off") {
    return null;
  }

  const isTime = cursors.mode === "time";

  const position = isTime
    ? Math.min(
        HORIZONTAL_DIVISIONS,
        Math.max(0, (x - grid.left) / grid.division.x),
      )
    : Math.min(
        VERTICAL_DIVISIONS / 2,
        Math.max(
          -VERTICAL_DIVISIONS / 2,
          (grid.top + grid.height / 2 - y) / grid.division.y,
        ),
      );

  const [first, second] = isTime ? cursors.times : cursors.levels;

  const index =
    Math.abs(position - first) <= Math.abs(position - second) ? 0 : 1;

  return { index, position };
}
