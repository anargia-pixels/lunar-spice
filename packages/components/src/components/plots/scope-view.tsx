import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@lunar-spice/components/ui/button";
import { Label } from "@lunar-spice/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lunar-spice/components/ui/select";
import { Slider } from "@lunar-spice/components/ui/slider";
import { Switch } from "@lunar-spice/components/ui/switch";
import { formatSi } from "@lunar-spice/simulator/units";
import { cn } from "@lunar-spice/utils/cn";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useCanvasPalette } from "../../hooks/use-canvas-palette";
import {
  ADD_TO_SCOPE_LABEL,
  orderedSamples,
  SCOPE_TIME_SPANS,
  SCOPE_VOLTAGE_SCALES,
  type Scope,
  type ScopeQuantity,
  type ScopeSettings,
  triggerLevelOf,
  triggerRangeOf,
} from "../../lib/scope";
import { traceSwatch } from "../../lib/trace-colors";
import {
  CURSOR_NAMES,
  drawPlot,
  type PlotData,
  PlotFrame,
} from "./plot-canvas";

/** How each strip names, colors and labels its quantity. */
const QUANTITIES = {
  voltage: { name: "Voltage", colorIndex: 0, unit: "V" },
  current: { name: "Current", colorIndex: 1, unit: "A" },
} as const;

/** The voltage scale choice that fits the trace instead of fixing a range. */
const AUTO_SCALE = "auto";

/** The time spans by their select value. */
const TIME_SPAN_LABELS = Object.fromEntries(
  SCOPE_TIME_SPANS.map((span) => [String(span), formatSi(span, "s")]),
);

/** The voltage scales by their select value, with fitting the trace first. */
const VOLTAGE_SCALE_LABELS = Object.fromEntries([
  [AUTO_SCALE, "Fit voltage"],
  ...SCOPE_VOLTAGE_SCALES.map((scale) => [
    String(scale),
    `±${formatSi(scale, "V")}`,
  ]),
]);

/** A compact dropdown in a scope's header. */
function ScaleSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        const match = Object.keys(options).find((key) => key === next);

        if (match !== undefined) {
          onChange(match);
        }
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {Object.entries(options).map(([key, text]) => (
          <SelectItem key={key} value={key}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Where the pointer and cursors sit on a scope, as fractions across its time window, so
 * they hold still while the trace scrolls. Both strips share one, so the crosshair and
 * cursors line up in time.
 */
type ScopePointer = {
  hover: number | null;
  cursors: readonly number[];
};

/** The sample nearest `fraction` across `frame`, or null on an empty trace. */
function sampleAt(frame: PlotFrame, fraction: number) {
  return frame.data.xValues.length === 0
    ? null
    : frame.nearestIndex(frame.left + fraction * frame.width);
}

/** The x value `fraction` across `frame`'s x range. */
function xAt(frame: PlotFrame, fraction: number) {
  return frame.x.min + fraction * (frame.x.max - frame.x.min);
}

/**
 * One live strip: voltage or current over the scope's recent samples, with the shared
 * crosshair and cursors.
 */
function ScopeStrip({
  scope,
  quantity,
  pointer,
  onHover,
  onPlace,
}: {
  scope: Scope;
  quantity: ScopeQuantity;
  /** Read on every frame, since the pointer moves without a render. */
  pointer: { readonly current: ScopePointer };
  onHover: (fraction: number | null) => void;
  onPlace: (fraction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<PlotFrame | null>(null);
  const palette = useCanvasPalette();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const { name, colorIndex, unit } = QUANTITIES[quantity];
    let frame = 0;
    let drawnState = "";

    // The simulation writes samples in place, so each frame checks for new ones.
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * ratio);
      const height = Math.round(rect.height * ratio);
      const isResized = canvas.width !== width || canvas.height !== height;

      // The settings change in place too, so they count as new content, as does the
      // pointer.
      const { hover, cursors } = pointer.current;

      const state = [
        scope.count,
        scope.timeSpan,
        scope.voltageScale,
        scope.isTriggered,
        scope.triggerLevel,
        hover,
        ...cursors,
      ].join(" ");

      if (isResized || state !== drawnState) {
        canvas.width = width;
        canvas.height = height;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        const { values, times, timeRange } = orderedSamples(scope, quantity);
        const level = scope.isTriggered ? triggerLevelOf(scope) : null;

        const data: PlotData = {
          xValues: times,
          series: [{ name, colorIndex, values }],
          xAxis: { scale: "linear", unit: "s" },
          yAxis: { scale: "linear", unit },
          xRange: timeRange,
        };

        if (quantity === "voltage" && scope.voltageScale !== null) {
          data.yRange = { min: -scope.voltageScale, max: scope.voltageScale };
        }

        if (quantity === "voltage" && level !== null) {
          data.levels = [{ y: level, label: "T" }];
        }

        const plotFrame = new PlotFrame(data, rect.width, rect.height);

        drawPlot(context, palette, plotFrame, {
          hoverIndex: hover === null ? null : sampleAt(plotFrame, hover),
          cursors: cursors.map((fraction) => xAt(plotFrame, fraction)),
        });
        frameRef.current = plotFrame;
        drawnState = state;
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [scope, quantity, palette, pointer]);

  /** How far across the time window the pointer is, or null outside it. */
  const fractionAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const plotFrame = frameRef.current;

    if (!plotFrame) {
      return null;
    }

    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;

    const fraction = (x - plotFrame.left) / plotFrame.width;

    return fraction >= 0 && fraction <= 1 ? fraction : null;
  };

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="min-h-0 w-full flex-1"
      onPointerMove={(event) => onHover(fractionAt(event))}
      onPointerLeave={() => onHover(null)}
      onPointerDown={(event) => {
        const fraction = fractionAt(event);

        if (fraction !== null && event.button === 0) {
          onPlace(fraction);
        }
      }}
    />
  );
}

/** How often the rows below a scope read what the simulation moves, in ms. */
const POLL_MS = 200;

/** Steps across the trigger slider, from the lowest level to the highest. */
const TRIGGER_STEPS = 100;

/**
 * A scope's trigger: a switch, the level slider and the level it triggers at. Until the
 * slider is moved the level follows the middle of the trace; Auto goes back to that.
 */
function TriggerRow({
  scope,
  onChange,
}: {
  scope: Scope;
  onChange: (settings: Partial<ScopeSettings>) => void;
}) {
  const id = useId();

  // The simulation moves both in place, so they are read on a timer.
  const [live, setLive] = useState(() => ({
    level: triggerLevelOf(scope) ?? 0,
    range: triggerRangeOf(scope),
  }));

  useEffect(() => {
    const read = () => {
      const level = triggerLevelOf(scope) ?? 0;
      const range = triggerRangeOf(scope);

      setLive((current) =>
        current.level === level && current.range === range
          ? current
          : { level, range },
      );
    };

    read();

    const timer = setInterval(read, POLL_MS);

    return () => clearInterval(timer);
  }, [scope, scope.triggerLevel, scope.voltageScale, scope.timeSpan]);

  const { level, range } = live;
  const isAuto = scope.triggerLevel === null;

  return (
    <div className="flex h-7 items-center gap-2 text-xs">
      <Switch
        id={id}
        size="sm"
        checked={scope.isTriggered}
        onCheckedChange={(isTriggered) => onChange({ isTriggered })}
      />
      <Label htmlFor={id}>Trigger</Label>
      <Slider
        aria-label="Trigger level"
        disabled={!scope.isTriggered}
        min={-range}
        max={range}
        step={(2 * range) / TRIGGER_STEPS}
        value={Math.max(-range, Math.min(range, level))}
        onValueChange={(position) => {
          const [first] = Array.isArray(position) ? position : [position];

          if (first !== undefined) {
            onChange({ triggerLevel: first });
          }
        }}
      />
      <output className="text-muted-foreground w-16 shrink-0 text-right tabular-nums">
        {scope.isTriggered ? formatSi(level, "V", 3) : "Off"}
      </output>
      <Button
        variant="ghost"
        size="xs"
        disabled={isAuto || !scope.isTriggered}
        onClick={() => onChange({ triggerLevel: null })}
      >
        Auto
      </Button>
    </div>
  );
}

/** The value of `quantity` at `time`, or null where the trace has no sample yet. */
function valueAt(scope: Scope, quantity: ScopeQuantity, time: number) {
  const { values, times } = orderedSamples(scope, quantity);
  const first = times[0];
  const last = times.at(-1);

  if (
    first === undefined ||
    last === undefined ||
    time < first ||
    time > last
  ) {
    return null;
  }

  let nearest = 0;

  for (let index = 1; index < times.length; index += 1) {
    if (
      Math.abs((times[index] ?? 0) - time) <
      Math.abs((times[nearest] ?? 0) - time)
    ) {
      nearest = index;
    }
  }

  return values[nearest] ?? null;
}

/**
 * Times at the cursors, and the voltage and current there; with two cursors, the change
 * from A to B in each and the frequency whose period is that time. The values follow
 * the trace, so they are read on a timer.
 */
function ScopeCursorReadout({
  scope,
  cursors,
  onClear,
}: {
  scope: Scope;
  cursors: readonly number[];
  onClear: () => void;
}) {
  // Readings belong to the cursors they were taken at, so a new cursor never shows
  // the last one's.
  const [reading, setReading] = useState<{
    cursors: readonly number[];
    times: readonly string[];
    values: readonly string[];
  } | null>(null);

  const [a, b] = cursors;

  useEffect(() => {
    if (a === undefined) {
      return;
    }

    const read = () => {
      const { min, max } = orderedSamples(scope, "voltage").timeRange;
      const timeOf = (fraction: number) => min + fraction * (max - min);

      const format = (quantity: ScopeQuantity) => {
        const { unit } = QUANTITIES[quantity];
        const atA = valueAt(scope, quantity, timeOf(a));

        if (b === undefined) {
          return atA === null ? "–" : formatSi(atA, unit, 4);
        }

        const atB = valueAt(scope, quantity, timeOf(b));

        return atA === null || atB === null
          ? "Δ –"
          : `Δ ${formatSi(atB - atA, unit, 4)}`;
      };

      // The window starts at the trigger once one is found, so times come from it.
      const times = cursors.map((fraction) =>
        formatSi(timeOf(fraction), "s", 4),
      );

      const values = [format("voltage"), format("current")];

      setReading((current) =>
        current?.cursors === cursors &&
        current.times.join() === times.join() &&
        current.values.join() === values.join()
          ? current
          : { cursors, times, values },
      );
    };

    read();

    const timer = setInterval(read, POLL_MS);

    return () => clearInterval(timer);
  }, [scope, cursors, a, b]);

  if (a === undefined) {
    return null;
  }

  const delta = b === undefined ? 0 : Math.abs(b - a) * scope.timeSpan;
  const isCurrent = reading?.cursors === cursors;
  const times = isCurrent ? reading.times : [];
  const values = isCurrent ? reading.values : [];

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
      {cursors.map((_, order) => (
        <span key={CURSOR_NAMES[order]}>
          {CURSOR_NAMES[order]} {times[order] ?? "–"}
        </span>
      ))}
      {b !== undefined && (
        <span>
          Δ {formatSi(delta, "s", 4)}
          {delta > 0 && ` · ${formatSi(1 / delta, "Hz", 4)}`}
        </span>
      )}
      {(["voltage", "current"] as const).map((quantity, index) => (
        <span key={quantity} className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-xs",
              traceSwatch(QUANTITIES[quantity].colorIndex),
            )}
          />
          {values[index] ?? "–"}
        </span>
      ))}
      <Button variant="ghost" size="xs" onClick={onClear}>
        Clear cursors
      </Button>
    </div>
  );
}

/**
 * One scope's card: its controls, both strips and the cursor readout. Hovering a strip
 * shows a crosshair on both; clicks place cursor A, then B, and a third click starts
 * over at A.
 */
function ScopeCard({
  scope,
  onRemove,
  onSettingsChange,
}: {
  scope: Scope;
  onRemove: () => void;
  onSettingsChange: (settings: Partial<ScopeSettings>) => void;
}) {
  const [cursors, setCursors] = useState<readonly number[]>([]);
  const pointer = useRef<ScopePointer>({ hover: null, cursors: [] });

  const placeCursors = (next: readonly number[]) => {
    pointer.current = { ...pointer.current, cursors: next };
    setCursors(next);
  };

  const strip = (quantity: ScopeQuantity) => (
    <ScopeStrip
      scope={scope}
      quantity={quantity}
      pointer={pointer}
      onHover={(hover) => {
        pointer.current = { ...pointer.current, hover };
      }}
      onPlace={(fraction) =>
        placeCursors(
          cursors.length < CURSOR_NAMES.length
            ? [...cursors, fraction]
            : [fraction],
        )
      }
    />
  );

  return (
    <section
      aria-label={scope.title}
      className="bg-card flex h-full w-96 shrink-0 flex-col gap-1 rounded-lg border p-2"
    >
      <header className="flex items-center gap-1">
        <h3 className="mr-auto min-w-0 truncate text-xs font-medium">
          {scope.title}
        </h3>
        <ScaleSelect
          label="Time span"
          value={String(scope.timeSpan)}
          options={TIME_SPAN_LABELS}
          onChange={(value) => onSettingsChange({ timeSpan: Number(value) })}
        />
        <ScaleSelect
          label="Voltage scale"
          value={
            scope.voltageScale === null
              ? AUTO_SCALE
              : String(scope.voltageScale)
          }
          options={VOLTAGE_SCALE_LABELS}
          onChange={(value) =>
            onSettingsChange({
              voltageScale: value === AUTO_SCALE ? null : Number(value),
            })
          }
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative after:absolute after:-inset-x-px after:-inset-y-1.75"
          aria-label={`Remove ${scope.title} scope`}
          onClick={onRemove}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <TriggerRow scope={scope} onChange={onSettingsChange} />
      {strip("voltage")}
      {strip("current")}
      <ScopeCursorReadout
        scope={scope}
        cursors={cursors}
        onClear={() => placeCursors([])}
      />
    </section>
  );
}

/**
 * Falstad-style scopes: each watched element's voltage and current, scrolling as the
 * interactive simulation runs. Voltage and current get separate strips, never one
 * chart with two y axes. Each scope sets its own time span, voltage scale and trigger.
 */
export function ScopeView({
  scopes,
  onRemove,
  onSettingsChange,
}: {
  scopes: readonly Scope[];
  onRemove: (elementId: number) => void;
  onSettingsChange: (
    elementId: number,
    settings: Partial<ScopeSettings>,
  ) => void;
}) {
  if (scopes.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-center text-sm text-balance">
        Right-click a component and choose {ADD_TO_SCOPE_LABEL} to watch its
        voltage and current here.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-3">
      {scopes.map((scope) => (
        <ScopeCard
          key={scope.elementId}
          scope={scope}
          onRemove={() => onRemove(scope.elementId)}
          onSettingsChange={(settings) =>
            onSettingsChange(scope.elementId, settings)
          }
        />
      ))}
    </div>
  );
}
