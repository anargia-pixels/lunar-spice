import {
  SidebarBottomIcon,
  PlayIcon,
  RotateLeft01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Hint } from "@lunar-spice/components/hint/hint";
import { RunIcon } from "@lunar-spice/components/run-icon/run-icon";
import { SidebarResizeRail } from "@lunar-spice/components/sidebar/sidebar-resize-rail";
import { Alert, AlertDescription } from "@lunar-spice/components/ui/alert";
import { Button } from "@lunar-spice/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@lunar-spice/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@lunar-spice/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lunar-spice/components/ui/select";
import { Separator } from "@lunar-spice/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from "@lunar-spice/components/ui/sidebar";
import { Slider } from "@lunar-spice/components/ui/slider";
import { Spinner } from "@lunar-spice/components/ui/spinner";
import {
  readSettings,
  settingsForSpeed,
  type SimulationSettings,
  speedMultiplier,
} from "@lunar-spice/simulator/circuit";
import {
  formatEditValue,
  formatSi,
  parseSi,
} from "@lunar-spice/simulator/units";
import { cn } from "@lunar-spice/utils/cn";
import { type CSSProperties, type ReactNode, useId, useState } from "react";

import { ANALYSIS_LABELS, ANALYSIS_NOTES } from "../lib/analysis-request";
import {
  appShortcutKeys,
  appShortcutText,
  runChosenAnalysis,
} from "../lib/app-commands";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useSidebarStore } from "../stores/sidebar-store";
import { useSimulationStore } from "../stores/simulation-store";
import { RegisterPanelToggle } from "./register-panel-toggle";

/**
 * The simulation speed slider's stops, in circuit seconds per second: 1-2-5 steps from
 * 1/1000 to 1000 × real time, with real time in the middle.
 */
const SPEED_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000,
];

/** The index of the stop nearest `multiplier` on a log scale; files can set any speed. */
function nearestSpeedStep(multiplier: number) {
  let best = 0;

  SPEED_STEPS.forEach((step, index) => {
    const distance = Math.abs(Math.log(step / multiplier));

    const bestDistance = Math.abs(
      Math.log((SPEED_STEPS[best] ?? 1) / multiplier),
    );

    if (distance < bestDistance) {
      best = index;
    }
  });

  return best;
}

/** A speed as the slider shows it: `1/100×` below real time, `20×` above. */
function speedLabel(multiplier: number) {
  if (multiplier >= 1) {
    return `${Number(multiplier.toPrecision(3))}×`;
  }

  return `1/${Number((1 / multiplier).toPrecision(3))}×`;
}

/** True for 1/1000, 1/100, …, 1000: the stops the slider marks with taller ticks. */
function isPowerOfTen(step: number) {
  const exponent = Math.log10(step);

  return Math.abs(exponent - Math.round(exponent)) < 1e-9;
}

/**
 * A tick under each of the speed slider's stops, taller at powers of ten, with labels at
 * both ends and real time in the middle. The padding matches the thumb's inset, so the
 * ticks and labels line up with the slider's stops.
 */
function SpeedTicks() {
  return (
    <div aria-hidden className="flex flex-col gap-1 px-1.5">
      <div className="flex justify-between">
        {SPEED_STEPS.map((step) => (
          <span
            key={step}
            className={cn(
              "w-px",
              isPowerOfTen(step) ? "bg-muted-foreground h-2" : "bg-border h-1",
            )}
          />
        ))}
      </div>
      <div className="text-muted-foreground grid grid-cols-3 text-xs whitespace-nowrap tabular-nums">
        <span>1/1000×</span>
        <span className="text-center">1×</span>
        <span className="text-right">1000×</span>
      </div>
    </div>
  );
}

/**
 * A number typed with SI prefixes. Each valid value applies as it is typed, so Ctrl+Enter
 * runs with it. Enter or leaving the field shows the applied value again.
 */
function SiField({
  label,
  unit,
  value,
  hint,
  isPositive = true,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  hint?: string;
  isPositive?: boolean;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? value : parseSi(draft);
  const isValid = parsed !== null && (isPositive ? parsed > 0 : parsed >= 0);

  const commit = () => setDraft(null);

  return (
    <Field data-invalid={!isValid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={draft ?? formatEditValue(value)}
          aria-invalid={!isValid}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            const value = parseSi(next);

            setDraft(next);

            if (value !== null && (isPositive ? value > 0 : value >= 0)) {
              onCommit(value);
            }
          }}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unit}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}

/** A labeled dropdown of fixed options. */
function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  const id = useId();
  const keys = Object.keys(options).filter((key): key is T => key in options);

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={options}
        value={value}
        onValueChange={(next) => {
          const match = keys.find((key) => key === next);

          if (match) {
            onChange(match);
          }
        }}
      >
        <SelectTrigger id={id} className="w-full justify-between">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {keys.map((key) => (
            <SelectItem key={key} value={key}>
              {options[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 p-4">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Controls for the interactive simulation: run, pause and reset, the speed and the wire
 * color scale. The speed sets the time step, so there is nothing else to tune.
 */
function InteractiveSection() {
  const status = useSimulationStore((state) => state.status);
  const text = useCircuitStore((state) => activeBuffer(state)?.text ?? "");
  const settings = readSettings(text);

  const editor = useSimulationStore((state) => state.editor);

  const update = (change: Partial<SimulationSettings>) =>
    editor?.updateSettings(change);

  const multiplier = speedMultiplier(settings);

  return (
    <PanelSection title="Interactive simulation">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => editor?.toggleRunning()}
        >
          <RunIcon isRunning={status.isRunning} className="size-3.5" />
          {status.isRunning ? "Pause" : "Run"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => editor?.resetSimulation()}
        >
          <HugeiconsIcon icon={RotateLeft01Icon} strokeWidth={2} />
          Reset
        </Button>
        <output className="text-muted-foreground ml-auto text-xs tabular-nums">
          {formatSi(status.time, "s", 4)}
        </output>
      </div>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>Simulation speed</FieldLabel>
          <output className="text-muted-foreground text-xs tabular-nums">
            {speedLabel(multiplier)}
          </output>
        </div>
        <Slider
          aria-label="Simulation speed"
          min={0}
          max={SPEED_STEPS.length - 1}
          step={1}
          value={nearestSpeedStep(multiplier)}
          onValueChange={(position) => {
            const [first] = Array.isArray(position) ? position : [position];
            const step = first === undefined ? undefined : SPEED_STEPS[first];

            if (step !== undefined) {
              update(settingsForSpeed(step));
            }
          }}
        />
        <SpeedTicks />
        <FieldDescription>
          {`${formatSi(multiplier, "s")} of circuit time per second; 1× is real time.`}
          {status.usesSound &&
            Math.abs(multiplier - 1) > 1e-6 &&
            " Microphones and speakers only work at 1×."}
        </FieldDescription>
      </Field>
      {status.audioError && (
        <Alert variant="destructive">
          <AlertDescription>{status.audioError}</AlertDescription>
        </Alert>
      )}
      <SiField
        label="Full-color voltage"
        unit="V"
        value={settings.voltageRange}
        hint="Wires shade fully at this voltage."
        onCommit={(voltageRange) => update({ voltageRange })}
      />
    </PanelSection>
  );
}

/**
 * The analysis picker, its settings, and Run. The Run button shows its shortcut only
 * where the panel is wide enough.
 */
function AnalysisSection() {
  const analysis = useSimulationStore((state) => state.analysis);
  const acOptions = useSimulationStore((state) => state.acOptions);

  const transientOptions = useSimulationStore(
    (state) => state.transientOptions,
  );

  const isAnalyzing = useSimulationStore((state) => state.isAnalyzing);
  const analysisError = useSimulationStore((state) => state.analysisError);

  const isResultsOpen = useSidebarStore((state) => state.resultsOpen);
  const toggleResults = useSidebarStore((state) => state.toggleResults);

  const { setAnalysis, setAcOptions, setTransientOptions, cancelAnalysis } =
    useSimulationStore.getState();

  return (
    <PanelSection title="Analysis">
      <ChoiceField
        label="Type"
        value={analysis}
        options={ANALYSIS_LABELS}
        onChange={setAnalysis}
      />
      <p className="text-muted-foreground text-xs text-pretty">
        {ANALYSIS_NOTES[analysis]}
      </p>
      {analysis === "ac" && (
        <>
          <SiField
            label="Start frequency"
            unit="Hz"
            value={acOptions.startFrequency}
            onCommit={(startFrequency) => setAcOptions({ startFrequency })}
          />
          <SiField
            label="Stop frequency"
            unit="Hz"
            value={acOptions.stopFrequency}
            onCommit={(stopFrequency) => setAcOptions({ stopFrequency })}
          />
          <ChoiceField
            label="Sweep"
            value={acOptions.scale}
            options={{ decade: "Decade", octave: "Octave", linear: "Linear" }}
            onChange={(scale) => setAcOptions({ scale })}
          />
          <SiField
            label={
              acOptions.scale === "linear"
                ? "Points"
                : `Points per ${acOptions.scale}`
            }
            unit="pts"
            value={acOptions.points}
            onCommit={(points) => setAcOptions({ points: Math.round(points) })}
          />
        </>
      )}
      {analysis === "transient" && (
        <>
          <SiField
            label="Stop time"
            unit="s"
            value={transientOptions.stopTime}
            onCommit={(stopTime) => setTransientOptions({ stopTime })}
          />
          <SiField
            label="Start recording at"
            unit="s"
            value={transientOptions.startTime}
            isPositive={false}
            onCommit={(startTime) => setTransientOptions({ startTime })}
          />
          <SiField
            label="Maximum time step"
            unit="s"
            value={transientOptions.maxTimeStep}
            onCommit={(maxTimeStep) => setTransientOptions({ maxTimeStep })}
          />
          <ChoiceField
            label="Initial conditions"
            value={transientOptions.initialConditions}
            options={{
              dc: "DC operating point",
              zero: "Zero (all discharged)",
            }}
            onChange={(initialConditions) =>
              setTransientOptions({ initialConditions })
            }
          />
        </>
      )}
      {analysisError && (
        <Alert variant="destructive">
          <AlertDescription>{analysisError}</AlertDescription>
        </Alert>
      )}
      {isAnalyzing ? (
        <Button variant="outline" onClick={cancelAnalysis}>
          <Spinner />
          Cancel
        </Button>
      ) : (
        <Hint
          label={`Run ${ANALYSIS_LABELS[analysis]}`}
          shortcut={appShortcutKeys("run-analysis")}
        >
          <Button className="@container w-full" onClick={runChosenAnalysis}>
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} />
            <span className="min-w-0 truncate">
              Run {ANALYSIS_LABELS[analysis]}
            </span>
            <span className="text-primary-foreground/70 ml-auto shrink-0 pl-2 text-xs @max-2xs:hidden">
              {appShortcutText("run-analysis")}
            </span>
          </Button>
        </Hint>
      )}
      <Hint
        label="Show or hide the results panel"
        shortcut={appShortcutKeys("toggle-results")}
      >
        <Button
          variant="outline"
          className="w-full"
          aria-pressed={isResultsOpen}
          onClick={toggleResults}
        >
          <HugeiconsIcon icon={SidebarBottomIcon} strokeWidth={2} />
          {isResultsOpen ? "Hide results" : "Show results"}
        </Button>
      </Hint>
    </PanelSection>
  );
}

/** The right-hand panel: interactive simulation controls above the analysis settings. */
export function SimulationPanel() {
  const open = useSidebarStore((state) => state.panelOpen);
  const setOpen = useSidebarStore((state) => state.setPanelOpen);
  const width = useSidebarStore((state) => state.panelWidth);
  const setWidth = useSidebarStore((state) => state.setPanelWidth);

  const sidebarStyle: CSSProperties & Record<"--sidebar-width", string> = {
    "--sidebar-width": `${width}px`,
  };

  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      keyboardShortcut={null}
      style={sidebarStyle}
      className="min-h-0 w-auto flex-none"
    >
      <RegisterPanelToggle panel="panel" />
      <Sidebar side="right">
        <div className="flex h-10 shrink-0 items-center border-b px-4 text-xs font-medium">
          Simulation
        </div>
        <SidebarContent>
          <InteractiveSection />
          <Separator />
          <AnalysisSection />
        </SidebarContent>
        <SidebarResizeRail
          width={width}
          onWidthChange={setWidth}
          side="right"
        />
      </Sidebar>
    </SidebarProvider>
  );
}
