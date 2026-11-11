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
import { useEffect, useId, useRef, useState } from "react";

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
import { drawPlot, type PlotData, PlotFrame } from "./plot-canvas";

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

/** One live strip: voltage or current over the scope's recent samples. */
function ScopeStrip({
  scope,
  quantity,
}: {
  scope: Scope;
  quantity: ScopeQuantity;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

      // The settings change in place too, so they count as new content.
      const state = [
        scope.count,
        scope.timeSpan,
        scope.voltageScale,
        scope.isTriggered,
        scope.triggerLevel,
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

        drawPlot(
          context,
          palette,
          new PlotFrame(data, rect.width, rect.height),
        );
        drawnState = state;
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [scope, quantity, palette]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="min-h-0 w-full flex-1"
    />
  );
}

/** How often the trigger row reads the level and range the simulation moves, in ms. */
const TRIGGER_POLL_MS = 200;

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

    const timer = setInterval(read, TRIGGER_POLL_MS);

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
        <section
          key={scope.elementId}
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
              onChange={(value) =>
                onSettingsChange(scope.elementId, { timeSpan: Number(value) })
              }
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
                onSettingsChange(scope.elementId, {
                  voltageScale: value === AUTO_SCALE ? null : Number(value),
                })
              }
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative after:absolute after:-inset-x-px after:-inset-y-1.75"
              aria-label={`Remove ${scope.title} scope`}
              onClick={() => onRemove(scope.elementId)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </header>
          <TriggerRow
            scope={scope}
            onChange={(settings) => onSettingsChange(scope.elementId, settings)}
          />
          <ScopeStrip scope={scope} quantity="voltage" />
          <ScopeStrip scope={scope} quantity="current" />
        </section>
      ))}
    </div>
  );
}
