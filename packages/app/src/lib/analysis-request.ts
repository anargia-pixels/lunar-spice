import type {
  AcSweepOptions,
  AnalysisResult,
  TransientOptions,
} from "@lunar-spice/simulator/analyses";

/** The analyses run outside the interactive simulation. */
export type AnalysisKind = AnalysisResult["kind"];

/** How the app names each analysis. */
export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  dc: "DC operating point",
  ac: "AC sweep",
  transient: "Transient",
};

/** What the simulation panel says each analysis does. */
export const ANALYSIS_NOTES: Record<AnalysisKind, string> = {
  dc: "Every node voltage and part current with capacitors open and inductors shorted.",
  ac: "Small-signal gain and phase. Sine sources drive the circuit with their amplitude and phase, microphones with their peak sound pressure; nonlinear parts are linearized at the operating point.",
  transient: "Voltages and currents over time with a fixed time step.",
};

/** What the analysis worker is asked to run. */
export type AnalysisRequest =
  | { kind: "dc"; text: string }
  | { kind: "ac"; text: string; options: AcSweepOptions }
  | { kind: "transient"; text: string; options: TransientOptions };

/** What the analysis worker answers with. */
export type AnalysisResponse =
  | { isOk: true; result: AnalysisResult }
  | { isOk: false; error: string };
