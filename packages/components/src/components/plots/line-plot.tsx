import { Button } from "@lunar-spice/components/ui/button";
import { formatSi } from "@lunar-spice/simulator/units";
import { cn } from "@lunar-spice/utils/cn";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCanvasPalette } from "../../hooks/use-canvas-palette";
import { traceSwatch } from "../../lib/trace-colors";
import {
  CURSOR_NAMES,
  drawPlot,
  PlotFrame,
  type PlotData,
} from "./plot-canvas";

const NO_CURSORS: readonly number[] = [];

/** Names each series beside its color; shown whenever a plot has two or more. */
function PlotLegend({
  series,
}: {
  series: readonly { name: string; colorIndex: number }[];
}) {
  if (series.length < 2) {
    return null;
  }

  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {series.map(({ name, colorIndex }) => (
        <li key={name} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-xs", traceSwatch(colorIndex))} />
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Values at the cursors: x at each, and with two cursors the change from A to B in x
 * and in every series.
 */
function CursorReadout({
  data,
  cursors,
  onClear,
}: {
  data: PlotData;
  cursors: readonly number[];
  onClear: () => void;
}) {
  const [a, b] = cursors;

  if (a === undefined) {
    return null;
  }

  const x = (index: number) => data.xValues[index] ?? 0;
  const y = (values: ArrayLike<number>, index: number) => values[index] ?? 0;

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
      {cursors.map((index, order) => (
        <span key={CURSOR_NAMES[order]}>
          {CURSOR_NAMES[order]} {formatSi(x(index), data.xAxis.unit, 4)}
        </span>
      ))}
      {b !== undefined && (
        <span>Δ {formatSi(x(b) - x(a), data.xAxis.unit, 4)}</span>
      )}
      {data.series.map(({ name, colorIndex, values }) => (
        <span key={name} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-xs", traceSwatch(colorIndex))} />
          {name}{" "}
          {b === undefined
            ? formatSi(y(values, a), data.yAxis.unit, 4)
            : `Δ ${formatSi(y(values, b) - y(values, a), data.yAxis.unit, 4)}`}
        </span>
      ))}
      <Button variant="ghost" size="xs" onClick={onClear}>
        Clear cursors
      </Button>
    </div>
  );
}

/**
 * A line plot with a crosshair readout that follows the pointer. Clicks place cursor A,
 * then B; a third click starts over at A. One y axis only: quantities in different
 * units belong in separate plots.
 */
export function LinePlot({
  title,
  data,
  className,
}: {
  title: string;
  data: PlotData;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Cursors belong to the x values they were placed on; new results drop them.
  const [placed, setPlaced] = useState<{
    xValues: ArrayLike<number>;
    cursors: readonly number[];
  }>({ xValues: data.xValues, cursors: NO_CURSORS });

  const cursors = placed.xValues === data.xValues ? placed.cursors : NO_CURSORS;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const palette = useCanvasPalette();

  // Ranges come from scanning every value, so they are worked out once per data
  // and size.
  const frame = useMemo(
    () => new PlotFrame(data, size.width, size.height),
    [data, size],
  );

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(canvas);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context || size.width === 0) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawPlot(context, palette, frame, {
      hoverIndex,
      cursors: cursors.map((index) => data.xValues[index] ?? 0),
    });
  }, [frame, size, hoverIndex, cursors, palette, data]);

  /** The sample nearest the pointer, or null on an empty plot. */
  const indexAt = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    data.xValues.length === 0
      ? null
      : frame.nearestIndex(
          event.clientX - event.currentTarget.getBoundingClientRect().left,
        );

  return (
    <figure className={cn("flex min-h-0 flex-col gap-1", className)}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-xs font-medium">
          {title}
          {cursors.length === 0 && (
            <span className="text-muted-foreground font-normal">
              {" "}
              · click to place cursors
            </span>
          )}
        </span>
        <PlotLegend series={data.series} />
      </figcaption>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="min-h-0 w-full flex-1"
        onPointerMove={(event) => setHoverIndex(indexAt(event))}
        onPointerLeave={() => setHoverIndex(null)}
        onPointerDown={(event) => {
          const index = indexAt(event);

          if (index !== null && event.button === 0) {
            setPlaced({
              xValues: data.xValues,
              cursors:
                cursors.length < CURSOR_NAMES.length
                  ? [...cursors, index]
                  : [index],
            });
          }
        }}
      />
      <CursorReadout
        data={data}
        cursors={cursors}
        onClear={() =>
          setPlaced({ xValues: data.xValues, cursors: NO_CURSORS })
        }
      />
    </figure>
  );
}
