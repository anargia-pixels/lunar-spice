import type { EditorController } from "@lunar-spice/components/circuit-editor/editor-controller";
import {
  INITIAL_STATUS,
  type SimulationStatus,
} from "@lunar-spice/components/circuit-editor/simulation-status";
import type { OscilloscopeEntry } from "@lunar-spice/components/lib/oscilloscope-feed";
import type { Scope } from "@lunar-spice/components/lib/scope";
import type {
  AcSweepOptions,
  AnalysisResult,
  TransientOptions,
} from "@lunar-spice/simulator/analyses";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  AnalysisKind,
  AnalysisRequest,
  AnalysisResponse,
} from "../lib/analysis-request";
import { useLayoutStore } from "./layout-store";

/** Which tab the results panel shows. */
export type ResultsTab = "oscilloscopes" | "scopes" | "analysis";

type SimulationStore = {
  editor: EditorController | null; // Runs the interactive simulation.
  analysis: AnalysisKind;
  acOptions: AcSweepOptions;
  transientOptions: TransientOptions;
  status: SimulationStatus; // As the editor last reported it.
  scopes: readonly Scope[];
  oscilloscopes: readonly OscilloscopeEntry[];
  result: AnalysisResult | null;
  resultCircuitId: string | null; // The circuit the result belongs to.
  resultText: string | null; // The circuit text the result came from.
  analysisError: string | null;
  isAnalyzing: boolean;
  resultsTab: ResultsTab;
  setAnalysis: (analysis: AnalysisKind) => void;
  setAcOptions: (options: Partial<AcSweepOptions>) => void;
  setTransientOptions: (options: Partial<TransientOptions>) => void;
  setEditor: (editor: EditorController | null) => void;
  setStatus: (status: SimulationStatus) => void;
  setScopes: (scopes: readonly Scope[]) => void;
  setOscilloscopes: (oscilloscopes: readonly OscilloscopeEntry[]) => void;
  setResultsTab: (tab: ResultsTab) => void;
  /** Resolves with the result, or why there is none, as when a later run replaced it. */
  runAnalysis: (circuitId: string, text: string) => Promise<AnalysisResponse>;
  cancelAnalysis: () => void;
};

/** The worker running the current analysis, so a new run or Cancel can stop it. */
let worker: Worker | null = null;

/** Settles the promise of the run `worker` is on. */
let settle: ((response: AnalysisResponse) => void) | null = null;

/** Stops the current run; its promise settles with `response`. */
function stopWorker(
  response: AnalysisResponse = {
    isOk: false,
    error: "The analysis was cancelled.",
  },
) {
  worker?.terminate();
  worker = null;
  settle?.(response);
  settle = null;
}

/** Analysis settings, remembered across launches, plus the latest results. */
export const useSimulationStore = create<SimulationStore>()(
  persist(
    (set, get) => ({
      editor: null,
      analysis: "dc",
      acOptions: {
        startFrequency: 1,
        stopFrequency: 1e6,
        scale: "decade",
        points: 20,
      },
      transientOptions: {
        startTime: 0,
        stopTime: 0.01,
        maxTimeStep: 1e-5,
        initialConditions: "dc",
      },
      status: INITIAL_STATUS,
      scopes: [],
      oscilloscopes: [],
      result: null,
      resultCircuitId: null,
      resultText: null,
      analysisError: null,
      isAnalyzing: false,
      resultsTab: "analysis",
      setAnalysis: (analysis) => set({ analysis }),
      setAcOptions: (options) =>
        set((state) => ({ acOptions: { ...state.acOptions, ...options } })),
      setTransientOptions: (options) =>
        set((state) => ({
          transientOptions: { ...state.transientOptions, ...options },
        })),
      setEditor: (editor) => set({ editor }),
      setStatus: (status) => set({ status }),
      setScopes: (scopes) => {
        const isAdded = scopes.length > get().scopes.length;

        // Show a new scope at once: open the results panel on the Scopes tab.
        set((state) => ({
          scopes,
          resultsTab: isAdded ? "scopes" : state.resultsTab,
        }));

        if (isAdded) {
          useLayoutStore.getState().setResultsOpen(true);
        }
      },
      setOscilloscopes: (oscilloscopes) => {
        const known = new Set(
          get().oscilloscopes.map(({ elementId }) => elementId),
        );

        const isAdded = oscilloscopes.some(
          ({ elementId }) => !known.has(elementId),
        );

        // Show a new oscilloscope's front panel at once.
        set((state) => ({
          oscilloscopes,
          resultsTab: isAdded ? "oscilloscopes" : state.resultsTab,
        }));

        if (isAdded) {
          useLayoutStore.getState().setResultsOpen(true);
        }
      },
      setResultsTab: (resultsTab) => set({ resultsTab }),
      runAnalysis: (circuitId, text) => {
        const { analysis, acOptions, transientOptions } = get();

        const request: AnalysisRequest =
          analysis === "ac"
            ? { kind: "ac", text, options: acOptions }
            : analysis === "transient"
              ? { kind: "transient", text, options: transientOptions }
              : { kind: "dc", text };

        // A new run stops the one before it.
        stopWorker();

        const current = new Worker(
          new URL("../lib/analysis-worker.ts", import.meta.url),
          { type: "module" },
        );

        worker = current;
        set({ isAnalyzing: true, analysisError: null, resultsTab: "analysis" });
        useLayoutStore.getState().setResultsOpen(true);

        const settled = new Promise<AnalysisResponse>((resolve) => {
          settle = resolve;
        });

        current.addEventListener(
          "message",
          (event: MessageEvent<AnalysisResponse>) => {
            const response = event.data;

            stopWorker(response);
            set(
              response.isOk
                ? {
                    isAnalyzing: false,
                    result: response.result,
                    resultCircuitId: circuitId,
                    resultText: text,
                  }
                : { isAnalyzing: false, analysisError: response.error },
            );
          },
        );
        current.addEventListener("error", (event) => {
          const error = event.message || "The analysis stopped unexpectedly.";

          stopWorker({ isOk: false, error });
          set({ isAnalyzing: false, analysisError: error });
        });
        current.postMessage(request);

        return settled;
      },
      cancelAnalysis: () => {
        stopWorker();
        set({ isAnalyzing: false });
      },
    }),
    {
      name: "lunar-spice-simulation",
      partialize: ({ analysis, acOptions, transientOptions }) => ({
        analysis,
        acOptions,
        transientOptions,
      }),
    },
  ),
);
