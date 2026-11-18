import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@lunar-spice/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@lunar-spice/components/ui/dropdown-menu";
import { Input } from "@lunar-spice/components/ui/input";
import { Slider } from "@lunar-spice/components/ui/slider";
import { Toggle } from "@lunar-spice/components/ui/toggle";
import {
  type Coupling,
  COUPLINGS,
  HORIZONTAL_DIVISIONS,
  MAX_MEASUREMENTS,
  OSCILLOSCOPE_CHANNELS,
  MEASUREMENT_KINDS,
  type MeasurementKind,
  type OscilloscopeChannel,
  type OscilloscopeSettings,
  SECONDS_PER_DIVISION,
  TRIGGER_EDGES,
  TRIGGER_MODES,
  type TriggerEdge,
  type TriggerMode,
  VERTICAL_DIVISIONS,
  VOLTS_PER_DIVISION,
} from "@lunar-spice/simulator/elements/oscilloscope";
import {
  formatEditValue,
  formatSi,
  parseSi,
} from "@lunar-spice/simulator/units";
import { cn } from "@lunar-spice/utils/cn";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCanvasPalette } from "../../hooks/use-canvas-palette";
import {
  autoset,
  type ChannelReadings,
  measureChannel,
  type OscilloscopeTrace,
  ROLL_SCREEN,
  screenTime,
  valueAt,
} from "../../lib/oscilloscope";
import {
  isTriggering,
  type OscilloscopeEntry,
  type OscilloscopeFeed,
  shownTrace,
} from "../../lib/oscilloscope-feed";
import { traceSwatch } from "../../lib/trace-colors";
import {
  CURSOR_MODES,
  cursorAt,
  type CursorMode,
  type Cursors,
  drawScreen,
  graticule,
  screenStart,
  triggerDivision,
  voltageAt,
} from "./oscilloscope-screen";
import { ScaleSelect } from "./scale-select";

/** How often readouts read what the simulation moves, in ms. */
const POLL_MS = 200;

/** Steps across a position or level slider per division. */
const SLIDER_STEPS_PER_DIVISION = 25;

/**
 * Width of a volts or seconds per division dropdown: room for its widest scale, such as
 * "500 mV/div", so the sliders beside them line up and stay put as scales change.
 */
const SCALE_WIDTH = "w-32 shrink-0 justify-between";

/** Width of a channel's on/off toggle, and of the heading above the column of them. */
const CHANNEL_WIDTH = "w-16 shrink-0 justify-start";

/** Width of a DC/AC/GND control, and of the heading above the column of them. */
const COUPLING_WIDTH = "w-28 shrink-0";

/** Width of the trigger and cursor controls, right of the vertical and horizontal ones. */
const SIDE_COLUMN = "w-56 shrink-0";

/** Width of a value typed beside a slider, room for "-12.5 mV". */
const FIELD_WIDTH = "w-20 shrink-0";

/** `options` keyed by value, with `value` added when a file set one off the list. */
function scaleOptions(
  values: readonly number[],
  value: number,
  label: (value: number) => string,
) {
  const all = values.includes(value)
    ? values
    : [...values, value].sort((a, b) => a - b);

  return Object.fromEntries(
    all.map((option) => [String(option), label(option)]),
  );
}

const voltsLabel = (value: number) => `${formatSi(value, "V")}/div`;

const secondsLabel = (value: number) => `${formatSi(value, "s")}/div`;

/** The channels by index, CH1 first. */
const CHANNELS = Array.from(
  { length: OSCILLOSCOPE_CHANNELS },
  (_, channel) => channel,
);

const CHANNEL_LABELS = Object.fromEntries(
  CHANNELS.map((channel) => [String(channel), `CH${channel + 1}`]),
);

const MODE_LABELS: Record<TriggerMode, string> = {
  auto: "Auto",
  normal: "Normal",
  single: "Single",
};

const EDGE_LABELS: Record<TriggerEdge, string> = {
  rising: "Rising",
  falling: "Falling",
};

const COUPLING_LABELS: Record<Coupling, string> = {
  dc: "DC",
  ac: "AC",
  gnd: "GND",
};

const CURSOR_LABELS: Record<CursorMode, string> = {
  off: "Off",
  time: "Time",
  voltage: "Voltage",
};

/** Each measurement's menu name, its short name on the screen, and its unit. */
const MEASUREMENTS: Record<
  MeasurementKind,
  { name: string; short: string; unit: string }
> = {
  frequency: { name: "Frequency", short: "Freq", unit: "Hz" },
  period: { name: "Period", short: "Period", unit: "s" },
  "peak-to-peak": { name: "Peak-to-peak", short: "Vpp", unit: "V" },
  maximum: { name: "Maximum", short: "Vmax", unit: "V" },
  minimum: { name: "Minimum", short: "Vmin", unit: "V" },
  mean: { name: "Mean", short: "Vavg", unit: "V" },
  rms: { name: "RMS", short: "Vrms", unit: "V" },
  duty: { name: "Duty cycle", short: "Duty", unit: "%" },
};

/** A measurement's value with four significant digits, or a dash while there is none. */
function formatMeasurement(kind: MeasurementKind, value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "–";
  }

  return kind === "duty"
    ? `${(value * 100).toFixed(1)} %`
    : formatSi(value, MEASUREMENTS[kind].unit, 4);
}

/** `value` held to `low` through `high`. */
function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

/**
 * A value beside a slider that also takes typing, for values finer than the slider's
 * steps: `250u`, `-1.5m` or `3 mV`. It shows the value with its unit; focus turns that
 * into the typed form, and each valid value applies as it is typed. Enter or leaving
 * shows the applied value again; Escape puts back the value it had on focus.
 */
function SiInput({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [initial, setInitial] = useState(value);
  const isValid = draft === null || parseSi(draft) !== null;

  return (
    <div className={FIELD_WIDTH}>
      <Input
        density="compact"
        aria-label={label}
        aria-invalid={!isValid}
        spellCheck={false}
        value={draft ?? formatSi(value, unit, 4)}
        onFocus={(event) => {
          setInitial(value);
          setDraft(formatEditValue(value));
          // The value changes on focus, so the selection waits for it to render.
          const input = event.currentTarget;

          requestAnimationFrame(() => input.select());
        }}
        onChange={(event) => {
          const next = event.target.value;
          const parsed = parseSi(next);

          setDraft(next);

          if (parsed !== null) {
            onChange(parsed);
          }
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            onChange(initial);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/** The first value of a slider's change, which may come as a list. */
function sliderValue(value: number | readonly number[]) {
  return Array.isArray(value) ? value[0] : value;
}

/** A labeled group of controls. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-muted-foreground text-xs font-medium">{title}</h4>
      {children}
    </section>
  );
}

/**
 * A segmented control: joined toggles on a muted track, exactly one pressed, one per
 * value in `values`. The track's radius is the segments' plus its padding.
 */
function Choice<T extends string>({
  label,
  value,
  values,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="bg-muted inline-flex h-7 w-fit shrink-0 items-center gap-0.5 rounded-lg p-0.5">
      <legend className="sr-only">{label}</legend>
      {values.map((option) => (
        <Toggle
          key={option}
          variant="segment"
          size="xs"
          pressed={option === value}
          onPressedChange={() => onChange(option)}
        >
          {labels[option]}
        </Toggle>
      ))}
    </fieldset>
  );
}

/**
 * One channel: on or off, its volts per division, its coupling, and where its 0 V sits
 * with that offset in volts. A channel that is off dims its controls until the pointer
 * or focus comes to the row.
 */
function ChannelRow({
  index,
  channel,
  onChange,
}: {
  index: number;
  channel: OscilloscopeChannel;
  onChange: (channel: OscilloscopeChannel) => void;
}) {
  const name = `CH${index + 1}`;

  return (
    <div className="group/channel flex h-7 items-center gap-2">
      <Toggle
        size="sm"
        variant="outline"
        pressed={channel.isOn}
        className={CHANNEL_WIDTH}
        onPressedChange={(isOn) => onChange({ ...channel, isOn })}
      >
        <span
          className={cn(
            "size-2 rounded-xs transition-opacity duration-150",
            traceSwatch(index),
            !channel.isOn && "opacity-40",
          )}
        />
        {name}
      </Toggle>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-150",
          !channel.isOn &&
            "opacity-50 group-focus-within/channel:opacity-100 group-hover/channel:opacity-100",
        )}
      >
        <ScaleSelect
          label={`${name} volts per division`}
          className={SCALE_WIDTH}
          value={String(channel.voltsPerDivision)}
          options={scaleOptions(
            VOLTS_PER_DIVISION,
            channel.voltsPerDivision,
            voltsLabel,
          )}
          onChange={(value) =>
            onChange({ ...channel, voltsPerDivision: Number(value) })
          }
        />
        <div className={COUPLING_WIDTH}>
          <Choice
            label={`${name} coupling`}
            value={channel.coupling}
            values={COUPLINGS}
            labels={COUPLING_LABELS}
            onChange={(coupling) => onChange({ ...channel, coupling })}
          />
        </div>
        <Slider
          aria-label={`${name} position`}
          className="min-w-12"
          min={-VERTICAL_DIVISIONS / 2}
          max={VERTICAL_DIVISIONS / 2}
          step={1 / SLIDER_STEPS_PER_DIVISION}
          value={channel.position}
          onValueChange={(value) => {
            const position = sliderValue(value);

            if (position !== undefined) {
              onChange({ ...channel, position });
            }
          }}
        />
        <SiInput
          label={`${name} offset`}
          unit="V"
          value={channel.position * channel.voltsPerDivision}
          onChange={(offset) =>
            onChange({
              ...channel,
              position: clamp(
                offset / channel.voltsPerDivision,
                -VERTICAL_DIVISIONS / 2,
                VERTICAL_DIVISIONS / 2,
              ),
            })
          }
        />
      </div>
    </div>
  );
}

/**
 * The vertical controls: a row per channel under column headings, each column as wide
 * in every row so the controls line up down the channels.
 */
function VerticalControls({
  settings,
  onChange,
}: {
  settings: OscilloscopeSettings;
  onChange: (settings: Partial<OscilloscopeSettings>) => void;
}) {
  return (
    <section
      aria-label="Vertical"
      className="flex min-w-0 flex-1 flex-col gap-1.5"
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <h4 className={cn(CHANNEL_WIDTH, "font-medium")}>Vertical</h4>
        <span aria-hidden="true" className={SCALE_WIDTH}>
          Scale
        </span>
        <span aria-hidden="true" className={COUPLING_WIDTH}>
          Coupling
        </span>
        <span aria-hidden="true" className="flex-1">
          Position
        </span>
        <span aria-hidden="true" className={FIELD_WIDTH}>
          Offset
        </span>
      </div>
      {CHANNELS.map((index) => {
        const channel = settings.channels[index];

        return channel ? (
          <ChannelRow
            key={index}
            index={index}
            channel={channel}
            onChange={(next) =>
              onChange({
                channels: settings.channels.map((current, kept) =>
                  kept === index ? next : current,
                ),
              })
            }
          />
        ) : null;
      })}
    </section>
  );
}

/** The time base: seconds per division and how far the trigger point sits from the middle. */
function HorizontalControls({
  settings,
  onChange,
}: {
  settings: OscilloscopeSettings;
  onChange: (settings: Partial<OscilloscopeSettings>) => void;
}) {
  return (
    <Section title="Horizontal">
      <div className="flex h-7 items-center gap-2 text-xs">
        <ScaleSelect
          label="Seconds per division"
          className={SCALE_WIDTH}
          value={String(settings.secondsPerDivision)}
          options={scaleOptions(
            SECONDS_PER_DIVISION,
            settings.secondsPerDivision,
            secondsLabel,
          )}
          onChange={(value) => onChange({ secondsPerDivision: Number(value) })}
        />
        <Slider
          aria-label="Horizontal position"
          className="min-w-12"
          min={-HORIZONTAL_DIVISIONS / 2}
          max={HORIZONTAL_DIVISIONS / 2}
          step={1 / SLIDER_STEPS_PER_DIVISION}
          value={settings.position}
          onValueChange={(value) => {
            const position = sliderValue(value);

            if (position !== undefined) {
              onChange({ position });
            }
          }}
        />
        <SiInput
          label="Delay"
          unit="s"
          value={settings.position * settings.secondsPerDivision}
          onChange={(delay) =>
            onChange({
              position: clamp(
                delay / settings.secondsPerDivision,
                -HORIZONTAL_DIVISIONS / 2,
                HORIZONTAL_DIVISIONS / 2,
              ),
            })
          }
        />
      </div>
    </Section>
  );
}

/**
 * The trigger: its mode, source, edge and level. The level slider spans the source's
 * screen; 50 % puts it in the middle of the source's signal.
 */
function TriggerControls({
  settings,
  feed,
  onChange,
}: {
  settings: OscilloscopeSettings;
  feed: OscilloscopeFeed;
  onChange: (settings: Partial<OscilloscopeSettings>) => void;
}) {
  const source = settings.triggerSource;
  const low = voltageAt(settings, source, -VERTICAL_DIVISIONS / 2);
  const high = voltageAt(settings, source, VERTICAL_DIVISIONS / 2);
  const reading = feed.meters[source]?.reading;

  return (
    <Section title="Trigger">
      <Choice
        label="Trigger mode"
        value={settings.triggerMode}
        values={TRIGGER_MODES}
        labels={MODE_LABELS}
        onChange={(triggerMode) => onChange({ triggerMode })}
      />
      <div className="flex items-center gap-2">
        <ScaleSelect
          label="Trigger source"
          value={String(source)}
          options={CHANNEL_LABELS}
          onChange={(value) => onChange({ triggerSource: Number(value) })}
        />
        <Choice
          label="Trigger edge"
          value={settings.triggerEdge}
          values={TRIGGER_EDGES}
          labels={EDGE_LABELS}
          onChange={(triggerEdge) => onChange({ triggerEdge })}
        />
      </div>
      <div className="flex h-7 items-center gap-2 text-xs">
        <Slider
          aria-label="Trigger level"
          className="min-w-12"
          min={low}
          max={high}
          step={(high - low) / (VERTICAL_DIVISIONS * SLIDER_STEPS_PER_DIVISION)}
          value={Math.min(high, Math.max(low, settings.triggerLevel))}
          onValueChange={(value) => {
            const triggerLevel = sliderValue(value);

            if (triggerLevel !== undefined) {
              onChange({ triggerLevel });
            }
          }}
        />
        <output
          aria-label="Trigger level"
          className="w-14 shrink-0 text-right text-xs tabular-nums"
        >
          {formatSi(settings.triggerLevel, "V", 3)}
        </output>
        <Button
          variant="outline"
          size="sm"
          aria-label="Trigger level to 50 %"
          disabled={!reading}
          onClick={() => {
            if (reading) {
              onChange({
                triggerLevel: (reading.minimum + reading.maximum) / 2,
              });
            }
          }}
        >
          50 %
        </Button>
      </div>
    </Section>
  );
}

/** The cursors: off, a pair of time cursors or a pair of voltage cursors on one channel. */
function CursorControls({
  cursors,
  onChange,
}: {
  cursors: Cursors;
  onChange: (cursors: Cursors) => void;
}) {
  return (
    <Section title="Cursors">
      <div className="flex items-center gap-2">
        <Choice
          label="Cursor mode"
          value={cursors.mode}
          values={CURSOR_MODES}
          labels={CURSOR_LABELS}
          onChange={(mode) => onChange({ ...cursors, mode })}
        />
        {cursors.mode === "voltage" && (
          <ScaleSelect
            label="Cursor channel"
            value={String(cursors.channel)}
            options={CHANNEL_LABELS}
            onChange={(value) =>
              onChange({ ...cursors, channel: Number(value) })
            }
          />
        )}
      </div>
    </Section>
  );
}

/**
 * The screen: the graticule and traces, redrawn whenever the shown trace, the front
 * panel or the cursors change. It picks the trace to show each frame and leaves it in
 * `shownRef` for the readouts. Dragging on it moves the nearer cursor.
 */
function Screen({
  feed,
  settings,
  cursors,
  isStopped,
  armedCount,
  shownRef,
  onSingleDone,
  onCursorsChange,
}: {
  feed: OscilloscopeFeed;
  settings: OscilloscopeSettings;
  cursors: Cursors;
  isStopped: boolean;
  /** The trigger count Single waits to pass; null while not armed. */
  armedCount: number | null;
  shownRef: RefObject<OscilloscopeTrace | null>;
  onSingleDone: () => void;
  onCursorsChange: (cursors: Cursors) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const palette = useCanvasPalette();
  const dragged = useRef<number | null>(null);

  // The drawing loop reads the latest props from here instead of restarting.
  const latest = useRef({
    settings,
    cursors,
    isStopped,
    armedCount,
    onSingleDone,
  });

  useLayoutEffect(() => {
    latest.current = { settings, cursors, isStopped, armedCount, onSingleDone };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    let frame = 0;
    let drawn: readonly unknown[] = [];

    const draw = () => {
      const current = latest.current;
      let trace = shownRef.current;

      if (!current.isStopped && current.settings.triggerMode !== "single") {
        trace = shownTrace(feed, current.settings);
      } else if (
        !current.isStopped &&
        current.armedCount !== null &&
        feed.triggerCount > current.armedCount
      ) {
        // Single shows the first trace after it was armed, then stops.
        trace = feed.triggered;
        latest.current = { ...current, isStopped: true, armedCount: null };
        current.onSingleDone();
      }

      shownRef.current = trace;

      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * ratio);
      const height = Math.round(rect.height * ratio);
      const state = [width, height, trace, current.settings, current.cursors];

      if (state.some((value, index) => value !== drawn[index])) {
        canvas.width = width;
        canvas.height = height;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawScreen(
          context,
          palette,
          { width: rect.width, height: rect.height },
          current.settings,
          trace,
          current.cursors,
        );
        drawn = state;
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [feed, palette, shownRef]);

  /** Moves cursor `index`, or the one nearer the pointer, to the pointer. */
  const moveCursor = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    index: number | null,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();

    const target = cursorAt(
      graticule(rect.width, rect.height),
      cursors,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );

    if (!target) {
      return null;
    }

    const which = index ?? target.index;
    const key = cursors.mode === "time" ? "times" : "levels";
    const positions: [number, number] = [...cursors[key]];

    positions[which] = target.position;
    onCursorsChange({ ...cursors, [key]: positions });

    return which;
  };

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "bg-card min-h-0 w-full flex-1 touch-none rounded-md border",
        cursors.mode !== "off" && "cursor-crosshair",
      )}
      onPointerDown={(event) => {
        if (event.button === 0 && cursors.mode !== "off") {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragged.current = moveCursor(event, null);
        }
      }}
      onPointerMove={(event) => {
        if (dragged.current !== null) {
          moveCursor(event, dragged.current);
        }
      }}
      onPointerUp={() => {
        dragged.current = null;
      }}
      onPointerCancel={() => {
        dragged.current = null;
      }}
    />
  );
}

/** Re-renders every `POLL_MS`, for readouts of what the simulation moves in place. */
function useTick() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), POLL_MS);

    return () => clearInterval(timer);
  }, []);
}

/** The trace the screen shows, read from `shownRef` every `POLL_MS`. */
function useShownTrace(shownRef: RefObject<OscilloscopeTrace | null>) {
  const [trace, setTrace] = useState<OscilloscopeTrace | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setTrace(shownRef.current), POLL_MS);

    return () => clearInterval(timer);
  }, [shownRef]);

  return trace;
}

/** Adds a measurement: a menu of channels, each with what it can measure. */
function AddMeasurement({
  onAdd,
}: {
  onAdd: (channel: number, kind: MeasurementKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" />}>
        <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        Measure
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {Object.entries(CHANNEL_LABELS).map(([channel, name]) => (
          <DropdownMenuSub key={channel}>
            <DropdownMenuSubTrigger>
              <span
                className={cn(
                  "size-2 rounded-xs",
                  traceSwatch(Number(channel)),
                )}
              />
              {name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {MEASUREMENT_KINDS.map((kind) => (
                <DropdownMenuItem
                  key={kind}
                  onClick={() => onAdd(Number(channel), kind)}
                >
                  {MEASUREMENTS[kind].name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chosen measurements of the shown trace, each removable, and a menu to add more. */
function Measurements({
  settings,
  shownRef,
  onChange,
}: {
  settings: OscilloscopeSettings;
  shownRef: RefObject<OscilloscopeTrace | null>;
  onChange: (settings: Partial<OscilloscopeSettings>) => void;
}) {
  const { measurements } = settings;
  const trace = useShownTrace(shownRef);
  const readings = new Map<number, ChannelReadings | null>();

  const readingsOf = (channel: number) => {
    if (!readings.has(channel)) {
      readings.set(channel, trace ? measureChannel(trace, channel) : null);
    }

    return readings.get(channel) ?? null;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
      {measurements.map(({ channel, kind }, index) => (
        <span
          key={`${channel} ${kind}`}
          className="bg-muted flex h-6 items-center gap-1.5 rounded-md pr-0.5 pl-2"
        >
          <span className={cn("size-2 rounded-xs", traceSwatch(channel))} />
          <span className="text-muted-foreground">
            {MEASUREMENTS[kind].short}
          </span>
          <span>
            {formatMeasurement(kind, readingsOf(channel)?.[kind] ?? null)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove CH${channel + 1} ${MEASUREMENTS[kind].name}`}
            onClick={() =>
              onChange({
                measurements: measurements.filter((_, kept) => kept !== index),
              })
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </span>
      ))}
      {measurements.length < MAX_MEASUREMENTS && (
        <AddMeasurement
          onAdd={(channel, kind) => {
            const isListed = measurements.some(
              (measurement) =>
                measurement.channel === channel && measurement.kind === kind,
            );

            if (!isListed) {
              onChange({ measurements: [...measurements, { channel, kind }] });
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * What the cursors read: for time cursors the two times from the trigger point, the time
 * between them and its frequency, and each channel's voltage at both; for voltage
 * cursors the two voltages and the difference.
 */
function CursorReadout({
  settings,
  cursors,
  shownRef,
}: {
  settings: OscilloscopeSettings;
  cursors: Cursors;
  shownRef: RefObject<OscilloscopeTrace | null>;
}) {
  const { secondsPerDivision } = settings;
  const [x1, x2] = cursors.times;
  const origin = triggerDivision(settings);
  const trace = useShownTrace(shownRef);

  if (cursors.mode === "off") {
    return null;
  }

  if (cursors.mode === "voltage") {
    const [y1, y2] = cursors.levels.map((level) =>
      voltageAt(settings, cursors.channel, level),
    );

    return (
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs tabular-nums">
        <span>Y1 {formatSi(y1 ?? 0, "V", 4)}</span>
        <span>Y2 {formatSi(y2 ?? 0, "V", 4)}</span>
        <span>ΔY {formatSi((y2 ?? 0) - (y1 ?? 0), "V", 4)}</span>
      </div>
    );
  }

  const delta = (x2 - x1) * secondsPerDivision;

  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
      <span>X1 {formatSi((x1 - origin) * secondsPerDivision, "s", 4)}</span>
      <span>X2 {formatSi((x2 - origin) * secondsPerDivision, "s", 4)}</span>
      <span>
        ΔX {formatSi(delta, "s", 4)}
        {delta !== 0 && ` · ${formatSi(1 / Math.abs(delta), "Hz", 4)}`}
      </span>
      {trace &&
        CHANNELS.map((channel) => {
          if (!settings.channels[channel]?.isOn) {
            return null;
          }

          const start = screenStart(trace, settings);
          const a = valueAt(trace, channel, start + x1 * secondsPerDivision);
          const b = valueAt(trace, channel, start + x2 * secondsPerDivision);

          return (
            <span key={channel} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-xs", traceSwatch(channel))} />
              {a === null || b === null
                ? "–"
                : `${formatSi(a, "V", 4)} · ${formatSi(b, "V", 4)} · Δ ${formatSi(b - a, "V", 4)}`}
            </span>
          );
        })}
    </div>
  );
}

/** What the acquisition is doing, as a bench scope's status reads. */
function statusOf(
  feed: OscilloscopeFeed,
  settings: OscilloscopeSettings,
  isStopped: boolean,
) {
  if (isStopped) {
    return "Stop";
  }

  const hasTriggered = isTriggering(feed, settings);

  if (settings.triggerMode === "auto") {
    if (screenTime(settings) >= ROLL_SCREEN) {
      return "Roll";
    }

    return hasTriggered ? "Trig'd" : "Auto";
  }

  return hasTriggered && settings.triggerMode === "normal" ? "Trig'd" : "Ready";
}

/** The acquisition's status, read again every `POLL_MS`. */
function StatusBadge({
  feed,
  settings,
  isStopped,
}: {
  feed: OscilloscopeFeed;
  settings: OscilloscopeSettings;
  isStopped: boolean;
}) {
  useTick();

  const status = statusOf(feed, settings, isStopped);

  return (
    <output
      className={cn(
        "rounded-sm px-1.5 py-0.5 text-xs font-medium",
        status === "Stop"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </output>
  );
}

/** The scale of each channel that is on, the time base and the trigger, under the screen. */
function ScaleReadout({
  settings,
  shownRef,
}: {
  settings: OscilloscopeSettings;
  shownRef: RefObject<OscilloscopeTrace | null>;
}) {
  const edge = settings.triggerEdge === "rising" ? "↑" : "↓";

  return (
    <div className="flex flex-wrap items-center gap-x-3 text-xs tabular-nums">
      {CHANNELS.map((index) => {
        const channel = settings.channels[index];

        return channel?.isOn ? (
          <span key={index} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-xs", traceSwatch(index))} />
            {voltsLabel(channel.voltsPerDivision)}
            {channel.coupling !== "dc" && (
              <span className="text-muted-foreground">
                {COUPLING_LABELS[channel.coupling]}
              </span>
            )}
          </span>
        ) : null;
      })}
      <span>{secondsLabel(settings.secondsPerDivision)}</span>
      <span className="text-muted-foreground">
        CH{settings.triggerSource + 1} {edge}{" "}
        {formatSi(settings.triggerLevel, "V", 3)}
      </span>
      <AcquisitionReadout shownRef={shownRef} />
    </div>
  );
}

/**
 * How the shown trace was acquired: the sample rate, one sample per simulation step, and
 * the record length, the samples across its screen. Dashes until there is a trace.
 */
function AcquisitionReadout({
  shownRef,
}: {
  shownRef: RefObject<OscilloscopeTrace | null>;
}) {
  const trace = useShownTrace(shownRef);

  const rate = trace ? formatSi(1 / trace.timeStep, "Sa/s", 3) : "– Sa/s";

  const length = trace
    ? formatSi(Math.round((trace.end - trace.start) / trace.timeStep), "pts", 3)
    : "– pts";

  return (
    <span className="text-muted-foreground ml-auto flex gap-x-3">
      <span aria-label="Sample rate">{rate}</span>
      <span aria-label="Record length">{length}</span>
    </span>
  );
}

/** Where the cursors start: time cursors at 3 and 7 divisions, voltage ones at ±2. */
const INITIAL_CURSORS: Cursors = {
  mode: "off",
  channel: 0,
  times: [3, 7],
  levels: [2, -2],
};

/**
 * One oscilloscope's front panel: the screen with its status, measurements and cursor
 * readout, and the vertical, horizontal, trigger and cursor controls. Run/Stop freezes
 * the screen; Single shows the next triggered trace and stops; Auto set fits the scales
 * and trigger to the signals.
 */
function OscilloscopePanel({
  entry,
  onSettingsChange,
}: {
  entry: OscilloscopeEntry;
  onSettingsChange: (settings: OscilloscopeSettings) => void;
}) {
  const { feed, settings } = entry;
  const [isStopped, setIsStopped] = useState(false);
  const [cursors, setCursors] = useState(INITIAL_CURSORS);
  const shownRef = useRef<OscilloscopeTrace | null>(null);

  const [armedCount, setArmedCount] = useState<number | null>(() =>
    settings.triggerMode === "single" ? feed.triggerCount : null,
  );

  const change = (next: Partial<OscilloscopeSettings>) =>
    onSettingsChange({ ...settings, ...next });

  /** Waits for the next triggered trace, then stops on it. */
  const armSingle = () => {
    setArmedCount(feed.triggerCount);
    setIsStopped(false);
  };

  return (
    <section
      aria-label={entry.title}
      className="bg-card flex h-full min-w-268 flex-1 gap-3 rounded-lg border p-2"
    >
      <div className="flex max-w-1/2 min-w-80 flex-1 flex-col gap-1.5">
        <header className="flex items-center gap-1.5">
          <h3 className="min-w-0 truncate text-xs font-medium">
            {entry.title}
          </h3>
          <StatusBadge feed={feed} settings={settings} isStopped={isStopped} />
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={isStopped ? "default" : "outline"}
              size="xs"
              onClick={() => {
                if (!isStopped) {
                  setIsStopped(true);
                } else if (settings.triggerMode === "single") {
                  armSingle();
                } else {
                  setIsStopped(false);
                }
              }}
            >
              {isStopped ? "Run" : "Stop"}
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (settings.triggerMode !== "single") {
                  change({ triggerMode: "single" });
                }

                armSingle();
              }}
            >
              Single
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                const next = autoset(settings, feed.meters);

                if (next) {
                  onSettingsChange(next);
                  setArmedCount(null);
                  setIsStopped(false);
                }
              }}
            >
              Auto set
            </Button>
          </div>
        </header>
        <Screen
          feed={feed}
          settings={settings}
          cursors={cursors}
          isStopped={isStopped}
          armedCount={armedCount}
          shownRef={shownRef}
          onSingleDone={() => {
            setIsStopped(true);
            setArmedCount(null);
          }}
          onCursorsChange={setCursors}
        />
        <ScaleReadout settings={settings} shownRef={shownRef} />
        <Measurements
          settings={settings}
          shownRef={shownRef}
          onChange={change}
        />
        <CursorReadout
          settings={settings}
          cursors={cursors}
          shownRef={shownRef}
        />
      </div>
      <div className="flex min-w-180 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex items-start gap-6">
          <VerticalControls settings={settings} onChange={change} />
          <div className={SIDE_COLUMN}>
            <TriggerControls
              settings={settings}
              feed={feed}
              onChange={(next) => {
                change(next);

                if (next.triggerMode === "single") {
                  armSingle();
                } else if (next.triggerMode !== undefined) {
                  setArmedCount(null);
                  setIsStopped(false);
                }
              }}
            />
          </div>
        </div>
        <div className="flex items-start gap-6 border-t pt-3">
          <div className="min-w-0 flex-1">
            <HorizontalControls settings={settings} onChange={change} />
          </div>
          <div className={SIDE_COLUMN}>
            <CursorControls cursors={cursors} onChange={setCursors} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The front panel of every oscilloscope in the schematic, the instrument a user wires
 * into the circuit: four channels against COM on a 10 × 8 division screen, with a
 * trigger, Auto set, measurements and cursors. Its settings are the oscilloscope's own
 * and save with the circuit.
 */
export function OscilloscopeView({
  oscilloscopes,
  onSettingsChange,
}: {
  oscilloscopes: readonly OscilloscopeEntry[];
  onSettingsChange: (elementId: number, settings: OscilloscopeSettings) => void;
}) {
  if (oscilloscopes.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-center text-sm text-balance">
        Place an oscilloscope from the components menu and wire its CH1 to CH4
        and COM to see its screen here.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-3">
      {oscilloscopes.map((entry) => (
        <OscilloscopePanel
          key={entry.elementId}
          entry={entry}
          onSettingsChange={(settings) =>
            onSettingsChange(entry.elementId, settings)
          }
        />
      ))}
    </div>
  );
}
