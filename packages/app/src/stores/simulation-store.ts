import type { EditorController } from "@lunar-spice/components/circuit-editor/editor-controller";
import {
  INITIAL_STATUS,
  type SimulationStatus,
} from "@lunar-spice/components/circuit-editor/simulation-status";
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
import { useSidebarStore } from "./sidebar-store";

/** Which tab the results panel shows. */
export type ResultsTab = "scopes" | "analysis";

type SimulationStore = {
  editor: EditorController | null; // Runs the interactive simulation.
  analysis: AnalysisKind;
  acOptions: AcSweepOptions;
  transientOptions: TransientOptions;
  status: SimulationStatus; // As the editor last reported it.
  scopes: readonly Scope[];
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
  setResultsTab: (tab: ResultsTab) => void;
  runAnalysis: (circuitId: string, text: string) => void;
  cancelAnalysis: () => void;
};

/** The worker running the current analysis, so a new run or Cancel can stop it. */
let worker: Worker | null = null;

function stopWorker() {
  worker?.terminate();
  worker = null;
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
          useSidebarStore.getState().setResultsOpen(true);
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
        useSidebarStore.getState().setResultsOpen(true);
        current.addEventListener(
          "message",
          (event: MessageEvent<AnalysisResponse>) => {
            stopWorker();

            const response = event.data;

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
          stopWorker();
          set({
            isAnalyzing: false,
            analysisError:
              event.message || "The analysis stopped unexpectedly.",
          });
        });
        current.postMessage(request);
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
