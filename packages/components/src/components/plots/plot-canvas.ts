import { formatSi } from "@lunar-spice/simulator/units";

import {
  type CanvasPalette,
  rgbText,
  traceColor,
} from "../../lib/canvas-palette";

/** One line on a plot; its color is the trace color in slot `colorIndex`. */
export type PlotSeries = {
  name: string;
  colorIndex: number;
  values: ArrayLike<number>;
};

type PlotAxis = {
  scale: "linear" | "log";
  unit: string;
};

/** A labeled x position, such as a −3 dB corner, drawn in a series' color. */
export type PlotMarker = {
  x: number;
  label: string;
  colorIndex: number;
};

/** A labeled y value, such as a scope's trigger level. */
type PlotLevel = {
  y: number;
  label: string;
};

/** Everything one plot draws: shared x values, the series and both axes. */
export type PlotData = {
  xValues: ArrayLike<number>;
  series: readonly PlotSeries[];
  xAxis: PlotAxis;
  yAxis: PlotAxis;
  /** The x range to show instead of the x values' own, such as a scope's time span. */
  xRange?: Range;
  /** The y range to show instead of one fitted to the series. */
  yRange?: Range;
  markers?: readonly PlotMarker[];
  /** Labeled y values drawn as dashed lines across the frame, such as a trigger level. */
  levels?: readonly PlotLevel[];
};

/** What the pointer adds to a plot: the hovered sample and up to two cursors. */
type PlotPointer = {
  hoverIndex: number | null;
  /** The x values of cursors A and B, in the order they were placed. */
  cursors: readonly number[];
};

/** Cursor names, in the order they are placed. */
export const CURSOR_NAMES = ["A", "B"] as const;

/** Space around the plot frame for tick labels, in CSS pixels. */
const MARGIN = { left: 60, right: 16, top: 10, bottom: 24 };

const FONT_SIZE = 11;

type Range = { min: number; max: number };

/** Round tick steps: 1, 2 or 5 times a power of ten, about `count` across `range`. */
function linearTicks({ min, max }: Range, count: number) {
  const raw = (max - min) / count;

  // A single sample has no span to divide; its one value is the only tick.
  if (!(raw > 0) || !Number.isFinite(raw)) {
    return [min];
  }

  const power = 10 ** Math.floor(Math.log10(raw));

  const step =
    [1, 2, 5, 10]
      .map((factor) => factor * power)
      .find((candidate) => candidate >= raw) ?? power * 10;

  const ticks: number[] = [];

  for (
    let tick = Math.ceil(min / step) * step;
    tick <= max + step * 1e-9;
    tick += step
  ) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
  }

  return ticks;
}

/** Every power of ten inside `range`. */
function logTicks({ min, max }: Range) {
  const ticks: number[] = [];

  for (
    let exponent = Math.ceil(Math.log10(min));
    exponent <= Math.floor(Math.log10(max));
    exponent += 1
  ) {
    ticks.push(10 ** exponent);
  }

  return ticks;
}

/**
 * The smallest and largest finite values; a log axis skips values of 0 or less. With
 * no such values, the range is 0 to 1, or 1 to 10 on a log axis.
 */
function extent(values: ArrayLike<number>, isLog: boolean): Range {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;

    if (Number.isFinite(value) && (!isLog || value > 0)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  return min <= max
    ? { min, max }
    : { min: isLog ? 1 : 0, max: isLog ? 10 : 1 };
}

/** The y range of every series, padded so lines never touch the frame. */
function valueRange(series: readonly PlotSeries[]): Range {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const { values } of series) {
    const range = extent(values, false);

    min = Math.min(min, range.min);
    max = Math.max(max, range.max);
  }

  if (!(min <= max)) {
    return { min: -1, max: 1 };
  }

  // A flat line gets a band around it; otherwise a small margin past either end.
  if (max === min) {
    const half = Math.max(Math.abs(max) * 0.2, 1e-9);

    return { min: min - half, max: max + half };
  }

  const margin = (max - min) * 0.06;

  return { min: min - margin, max: max + margin };
}

/** Maps data to pixels inside the plot frame and back. */
export class PlotFrame {
  /** The whole canvas, in CSS pixels; the frame sits inside its margins. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** The frame's box on the canvas, in CSS pixels. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The data range each axis shows. */
  readonly x: Range;
  readonly y: Range;
  readonly data: PlotData;

  constructor(data: PlotData, width: number, height: number) {
    this.data = data;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.left = MARGIN.left;
    this.top = MARGIN.top;
    this.width = Math.max(1, width - MARGIN.left - MARGIN.right);
    this.height = Math.max(1, height - MARGIN.top - MARGIN.bottom);
    this.x = data.xRange ?? extent(data.xValues, data.xAxis.scale === "log");
    this.y = data.yRange ?? valueRange(data.series);
  }

  /** Where `value` sits in `range`, from 0 to 1, on a linear or log scale. */
  private fraction(value: number, range: Range, isLog: boolean) {
    if (isLog) {
      return (
        (Math.log10(value) - Math.log10(range.min)) /
        (Math.log10(range.max) - Math.log10(range.min) || 1)
      );
    }

    return (value - range.min) / (range.max - range.min || 1);
  }

  xPixel(value: number) {
    return (
      this.left +
      this.fraction(value, this.x, this.data.xAxis.scale === "log") * this.width
    );
  }

  yPixel(value: number) {
    return this.top + (1 - this.fraction(value, this.y, false)) * this.height;
  }

  /** The index of the x value nearest the pixel column `pixel`, by binary search. */
  nearestIndex(pixel: number) {
    const { xValues } = this.data;
    let low = 0;
    let high = xValues.length - 1;

    while (high - low > 1) {
      const middle = (low + high) >> 1;

      if (this.xPixel(xValues[middle] ?? 0) < pixel) {
        low = middle;
      } else {
        high = middle;
      }
    }

    const lowGap = Math.abs(this.xPixel(xValues[low] ?? 0) - pixel);
    const highGap = Math.abs(this.xPixel(xValues[high] ?? 0) - pixel);

    return lowGap <= highGap ? low : high;
  }
}

/**
 * Draws the plot `frame` lays out into `context`: recessive grid and axes, 2 px series
 * lines, markers, cursors, and at the hovered sample a crosshair with a readout of
 * every series.
 */
export function drawPlot(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  frame: PlotFrame,
  pointer: PlotPointer = { hoverIndex: null, cursors: [] },
) {
  const { data, canvasWidth: width, canvasHeight: height } = frame;
  // Ticks and the hover readout use equal-width digits, so values do not jitter.
  const font = `${FONT_SIZE}px ${palette.codeFontFamily}`;
  const ink = rgbText(palette.foreground);
  const mutedInk = rgbText(palette.muted);

  // Grid and tick labels
  context.clearRect(0, 0, width, height);
  context.font = font;
  context.lineWidth = 1;
  context.strokeStyle = palette.border;
  context.fillStyle = mutedInk;

  const xTicks =
    data.xAxis.scale === "log"
      ? logTicks(frame.x)
      : linearTicks(frame.x, Math.max(2, Math.floor(frame.width / 90)));

  // At least three ticks, so even a short scope strip shows its scale.
  const yTicks = linearTicks(
    frame.y,
    Math.max(3, Math.floor(frame.height / 40)),
  );

  context.textAlign = "center";
  context.textBaseline = "top";

  for (const tick of xTicks) {
    const x = Math.round(frame.xPixel(tick)) + 0.5;

    context.beginPath();
    context.moveTo(x, frame.top);
    context.lineTo(x, frame.top + frame.height);
    context.stroke();
    context.fillText(
      formatSi(tick, data.xAxis.unit),
      x,
      frame.top + frame.height + 6,
    );
  }

  context.textAlign = "right";
  context.textBaseline = "middle";

  for (const tick of yTicks) {
    const y = Math.round(frame.yPixel(tick)) + 0.5;

    context.beginPath();
    context.moveTo(frame.left, y);
    context.lineTo(frame.left + frame.width, y);
    context.stroke();
    context.fillText(formatSi(tick, data.yAxis.unit), frame.left - 8, y);
  }

  // Series lines, clipped to the frame
  context.save();
  context.beginPath();
  context.rect(frame.left, frame.top, frame.width, frame.height);
  context.clip();
  context.lineWidth = 2;
  context.lineJoin = "round";

  for (const series of data.series) {
    context.strokeStyle = traceColor(palette, series.colorIndex);
    context.beginPath();

    let isDrawing = false;

    for (let index = 0; index < series.values.length; index += 1) {
      const value = series.values[index] ?? 0;
      const xValue = data.xValues[index] ?? 0;

      if (
        !Number.isFinite(value) ||
        (data.xAxis.scale === "log" && xValue <= 0)
      ) {
        isDrawing = false;
        continue;
      }

      const x = frame.xPixel(xValue);
      const y = frame.yPixel(value);

      if (isDrawing) {
        context.lineTo(x, y);
      } else {
        context.moveTo(x, y);
        isDrawing = true;
      }
    }

    context.stroke();
  }

  context.restore();

  // Markers, cursors and the hover readout
  for (const marker of data.markers ?? []) {
    drawVerticalLine(
      context,
      frame,
      frame.xPixel(marker.x),
      traceColor(palette, marker.colorIndex),
      marker.label,
      [4, 3],
    );
  }

  for (const level of data.levels ?? []) {
    drawLevelLine(context, frame, frame.yPixel(level.y), ink, level.label);
  }

  if (data.xValues.length === 0) {
    return;
  }

  pointer.cursors.forEach((x, order) =>
    drawVerticalLine(
      context,
      frame,
      frame.xPixel(x),
      ink,
      CURSOR_NAMES[order] ?? "",
      [],
    ),
  );

  if (pointer.hoverIndex !== null) {
    drawReadout(context, palette, frame, pointer.hoverIndex);
  }
}

/** A full-height line at pixel column `x` with `label` at its top, inside the frame. */
function drawVerticalLine(
  context: CanvasRenderingContext2D,
  frame: PlotFrame,
  x: number,
  color: string,
  label: string,
  dash: number[],
) {
  if (x < frame.left || x > frame.left + frame.width) {
    return;
  }

  const column = Math.round(x) + 0.5;

  const isNearRight =
    column + 8 + context.measureText(label).width > frame.left + frame.width;

  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(column, frame.top);
  context.lineTo(column, frame.top + frame.height);
  context.stroke();
  context.fillStyle = color;
  context.textAlign = isNearRight ? "right" : "left";
  context.textBaseline = "top";
  context.fillText(label, column + (isNearRight ? -4 : 4), frame.top + 2);
  context.restore();
}

/** A dashed full-width line at pixel row `y` with `label` at its right end, inside the frame. */
function drawLevelLine(
  context: CanvasRenderingContext2D,
  frame: PlotFrame,
  y: number,
  color: string,
  label: string,
) {
  if (y < frame.top || y > frame.top + frame.height) {
    return;
  }

  const row = Math.round(y) + 0.5;
  const isNearTop = row - FONT_SIZE - 4 < frame.top;

  context.save();
  context.strokeStyle = color;
  context.globalAlpha = 0.6;
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  context.beginPath();
  context.moveTo(frame.left, row);
  context.lineTo(frame.left + frame.width, row);
  context.stroke();
  context.fillStyle = color;
  context.textAlign = "right";
  context.textBaseline = isNearTop ? "top" : "bottom";
  context.fillText(
    label,
    frame.left + frame.width - 4,
    row + (isNearTop ? 3 : -3),
  );
  context.restore();
}

/** The crosshair at `index` with a box listing x and each series' value there. */
function drawReadout(
  context: CanvasRenderingContext2D,
  palette: CanvasPalette,
  frame: PlotFrame,
  index: number,
) {
  const { data } = frame;
  const xValue = data.xValues[index] ?? 0;
  const x = Math.round(frame.xPixel(xValue)) + 0.5;

  const lines = [
    { text: formatSi(xValue, data.xAxis.unit, 4), color: null },
    ...data.series.map((series) => ({
      text: `${series.name}  ${formatSi(series.values[index] ?? 0, data.yAxis.unit, 4)}`,
      color: traceColor(palette, series.colorIndex),
    })),
  ];

  // Crosshair, with a dot on each series
  context.strokeStyle = rgbText(palette.muted, 0.6);
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, frame.top);
  context.lineTo(x, frame.top + frame.height);
  context.stroke();

  for (const series of data.series) {
    const value = series.values[index] ?? 0;

    if (!Number.isFinite(value)) {
      continue;
    }

    context.fillStyle = palette.card;
    context.strokeStyle = traceColor(palette, series.colorIndex);
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, frame.yPixel(value), 4, 0, 2 * Math.PI);
    context.fill();
    context.stroke();
  }

  // Readout box, beside the crosshair and flipped left near the right edge
  const lineHeight = FONT_SIZE + 6;

  const boxWidth =
    Math.max(...lines.map(({ text }) => context.measureText(text).width)) + 28;

  const boxHeight = lines.length * lineHeight + 8;

  const boxX =
    x + 12 + boxWidth > frame.left + frame.width ? x - 12 - boxWidth : x + 12;

  const boxY = frame.top + 4;

  context.fillStyle = palette.card;
  context.strokeStyle = palette.border;
  context.beginPath();
  context.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
  context.fill();
  context.stroke();
  context.textAlign = "left";
  context.textBaseline = "middle";

  lines.forEach(({ text, color }, line) => {
    const y = boxY + 4 + lineHeight * (line + 0.5);

    if (color) {
      context.fillStyle = color;
      context.fillRect(boxX + 8, y - 4, 8, 8);
    }

    context.fillStyle = color
      ? rgbText(palette.foreground)
      : rgbText(palette.muted);
    context.fillText(text, boxX + (color ? 22 : 8), y);
  });
}
