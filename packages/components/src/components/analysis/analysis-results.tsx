import { Checkbox } from "@lunar-spice/components/ui/checkbox";
import { Label } from "@lunar-spice/components/ui/label";
import { ScrollArea } from "@lunar-spice/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lunar-spice/components/ui/table";
import {
  type AcSweepResult,
  cornerFrequencies,
  type OperatingPointResult,
  toDecibels,
  type TransientResult,
} from "@lunar-spice/simulator/analyses";
import { formatSi } from "@lunar-spice/simulator/units";
import { cn } from "@lunar-spice/utils/cn";
import { useId, useMemo, useState } from "react";

import { TRACE_COUNT, traceSwatch } from "../../lib/trace-colors";
import { LinePlot } from "../plots/line-plot";
import type { PlotMarker, PlotSeries } from "../plots/plot-canvas";

/** Traces shown at first when no net is labeled. */
const FIRST_SHOWN = 3;

/** A plottable result: its name and whether results feature it (labeled nets, probes). */
type TraceItem = {
  name: string;
  isFeatured: boolean;
};

/** The traces a new result starts with: labeled nets, or without any, the first few. */
function initialSlots(items: readonly TraceItem[]) {
  const featured = items.filter(({ isFeatured }) => isFeatured);

  const initial =
    featured.length > 0
      ? featured.slice(0, TRACE_COUNT)
      : items.slice(0, FIRST_SHOWN);

  return new Map(initial.map(({ name }, slot) => [name, slot]));
}

/**
 * Which traces are shown and the color slot each holds, at most one per trace color. A
 * trace keeps its slot while it stays shown, so toggling others never repaints it. A new
 * result starts over from `initialSlots`.
 */
function useTraceSlots(items: readonly TraceItem[]) {
  const [state, setState] = useState(() => ({
    items,
    slots: initialSlots(items),
  }));

  const slots = state.items === items ? state.slots : initialSlots(items);

  const toggle = (name: string, isShown: boolean) =>
    setState(() => {
      const next = new Map(slots);

      if (!isShown) {
        next.delete(name);

        return { items, slots: next };
      }

      const used = new Set(next.values());

      const free = Array.from({ length: TRACE_COUNT }, (_, slot) => slot).find(
        (slot) => !used.has(slot),
      );

      if (free !== undefined) {
        next.set(name, free);
      }

      return { items, slots: next };
    });

  return { slots, toggle };
}

/** The list of traces with a checkbox each, in the result's order. */
function TracePicker({
  items,
  slots,
  onToggle,
}: {
  items: readonly TraceItem[];
  slots: ReadonlyMap<string, number>;
  onToggle: (name: string, isShown: boolean) => void;
}) {
  const id = useId();

  return (
    <div className="w-44 shrink-0 border-r">
      <ScrollArea className="h-full">
        <ul aria-label="Traces" className="flex flex-col gap-1 p-3">
          {items.map(({ name }) => {
            const slot = slots.get(name);
            const isFull = slots.size >= TRACE_COUNT && slot === undefined;

            return (
              <li key={name} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${name}`}
                  checked={slot !== undefined}
                  disabled={isFull}
                  onCheckedChange={(checked) => onToggle(name, checked)}
                />
                <Label htmlFor={`${id}-${name}`} className="min-w-0 flex-1">
                  <span className="font-code truncate text-xs">{name}</span>
                </Label>
                {slot !== undefined && (
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-xs",
                      traceSwatch(slot),
                    )}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

function EmptyPlot({ message }: { message: string }) {
  return (
    <p className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
      {message}
    </p>
  );
}

/** Node voltages, then each part's voltage, current and power, as two tables. */
export function OperatingPointResults({
  result,
}: {
  result: OperatingPointResult;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-2 gap-6 p-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Net</TableHead>
              <TableHead className="text-right">Voltage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.nets.map((net) => (
              <TableRow key={net.name}>
                <TableCell>
                  <span
                    className={cn("font-code", net.isFeatured && "font-medium")}
                  >
                    {net.name}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">
                    {formatSi(net.voltage, "V", 4)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead className="text-right">Voltage</TableHead>
              <TableHead className="text-right">Current</TableHead>
              <TableHead className="text-right">Power</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.elements.map((element) => (
              <TableRow key={element.designator}>
                <TableCell title={element.name}>
                  <span className="font-code">{element.designator}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">
                    {formatSi(element.voltage, "V", 4)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">
                    {formatSi(element.current, "A", 4)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">
                    {formatSi(element.power, "W", 3)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </ScrollArea>
  );
}

/**
 * Bode plots: gain in dB above phase in degrees, sharing a log frequency axis. The gain
 * plot marks each shown net's −3 dB corners.
 */
export function AcSweepResults({ result }: { result: AcSweepResult }) {
  const { slots, toggle } = useTraceSlots(result.nets);

  const plots = useMemo(() => {
    const shown = result.nets.filter(({ name }) => slots.has(name));

    const series = (pick: (net: AcSweepResult["nets"][number]) => number[]) =>
      shown.map((net): PlotSeries => ({
        name: net.name,
        colorIndex: slots.get(net.name) ?? 0,
        values: pick(net),
      }));

    const corners = shown.flatMap((net): PlotMarker[] =>
      cornerFrequencies(result.frequencies, net.magnitude).map((frequency) => ({
        x: frequency,
        label: `−3 dB ${formatSi(frequency, "Hz", 3)}`,
        colorIndex: slots.get(net.name) ?? 0,
      })),
    );

    return {
      magnitude: series((net) => net.magnitude.map(toDecibels)),
      corners,
      phase: series((net) => net.phase),
    };
  }, [result, slots]);

  return (
    <div className="flex h-full min-h-0">
      <TracePicker items={result.nets} slots={slots} onToggle={toggle} />
      {plots.magnitude.length === 0 ? (
        <EmptyPlot message="Pick a net to plot its response." />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          <LinePlot
            title="Gain"
            className="flex-1"
            data={{
              xValues: result.frequencies,
              series: plots.magnitude,
              xAxis: { scale: "log", unit: "Hz" },
              yAxis: { scale: "linear", unit: "dB" },
              markers: plots.corners,
            }}
          />
          <LinePlot
            title="Phase"
            className="flex-1"
            data={{
              xValues: result.frequencies,
              series: plots.phase,
              xAxis: { scale: "log", unit: "Hz" },
              yAxis: { scale: "linear", unit: "°" },
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Voltages and currents over time, each unit in its own plot. */
export function TransientResults({ result }: { result: TransientResult }) {
  const { slots, toggle } = useTraceSlots(result.traces);

  const plots = useMemo(() => {
    const shown = result.traces.filter(({ name }) => slots.has(name));

    const series = (unit: "V" | "A") =>
      shown
        .filter((trace) => trace.unit === unit)
        .map((trace): PlotSeries => ({
          name: trace.name,
          colorIndex: slots.get(trace.name) ?? 0,
          values: trace.values,
        }));

    return { voltages: series("V"), currents: series("A") };
  }, [result, slots]);

  const isEmpty = plots.voltages.length === 0 && plots.currents.length === 0;

  return (
    <div className="flex h-full min-h-0">
      <TracePicker items={result.traces} slots={slots} onToggle={toggle} />
      {isEmpty ? (
        <EmptyPlot message="Pick a voltage or current to plot." />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          {plots.voltages.length > 0 && (
            <LinePlot
              title="Voltage"
              className="flex-1"
              data={{
                xValues: result.times,
                series: plots.voltages,
                xAxis: { scale: "linear", unit: "s" },
                yAxis: { scale: "linear", unit: "V" },
              }}
            />
          )}
          {plots.currents.length > 0 && (
            <LinePlot
              title="Current"
              className="flex-1"
              data={{
                xValues: result.times,
                series: plots.currents,
                xAxis: { scale: "linear", unit: "s" },
                yAxis: { scale: "linear", unit: "A" },
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
