import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AcSweepResults,
  OperatingPointResults,
  TransientResults,
} from "@lunar-spice/components/analysis/analysis-results";
import { ScopeView } from "@lunar-spice/components/plots/scope-view";
import { Button } from "@lunar-spice/components/ui/button";
import { Spinner } from "@lunar-spice/components/ui/spinner";
import { TabItem, Tabs, TabsList } from "@lunar-spice/components/ui/tabs";

import { ANALYSIS_LABELS } from "../lib/analysis-request";
import { useCircuitStore } from "../stores/circuit-store";
import { useLayoutStore } from "../stores/layout-store";
import {
  type ResultsTab,
  useSimulationStore,
} from "../stores/simulation-store";

/** The latest analysis result for the open circuit, or why there is none. */
function AnalysisContent() {
  const activeId = useCircuitStore((state) => state.activeId);
  const result = useSimulationStore((state) => state.result);
  const resultCircuitId = useSimulationStore((state) => state.resultCircuitId);
  const isAnalyzing = useSimulationStore((state) => state.isAnalyzing);
  const analysisError = useSimulationStore((state) => state.analysisError);

  if (isAnalyzing) {
    return (
      <p className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner />
        Running the analysis…
      </p>
    );
  }

  if (analysisError) {
    return (
      <p className="text-destructive flex h-full items-center justify-center p-6 text-center text-sm text-balance">
        {analysisError}
      </p>
    );
  }

  if (!result || resultCircuitId !== activeId) {
    return (
      <p className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm text-balance">
        Pick an analysis in the simulation panel and run it to see results here.
      </p>
    );
  }

  switch (result.kind) {
    case "dc":
      return <OperatingPointResults result={result} />;
    case "ac":
      return <AcSweepResults result={result} />;
    case "transient":
      return <TransientResults result={result} />;
  }
}

/**
 * Live scopes and the latest analysis result. It fills the panel under the canvas, which
 * the editor page sizes and only shows while results are open.
 */
export function ResultsPanel() {
  const setOpen = useLayoutStore((state) => state.setResultsOpen);
  const tab = useSimulationStore((state) => state.resultsTab);
  const setTab = useSimulationStore((state) => state.setResultsTab);
  const scopes = useSimulationStore((state) => state.scopes);
  const result = useSimulationStore((state) => state.result);
  const editor = useSimulationStore((state) => state.editor);

  return (
    <section
      aria-label="Results"
      className="bg-background flex h-full min-h-0 flex-col"
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === "scopes" || next === "analysis") {
            setTab(next satisfies ResultsTab);
          }
        }}
        size="compact"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <TabsList>
            <TabItem
              value="analysis"
              label={result ? ANALYSIS_LABELS[result.kind] : "Analysis"}
            />
            <TabItem value="scopes" label={`Scopes ${scopes.length}`} />
          </TabsList>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close results"
            onClick={() => setOpen(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {tab === "scopes" ? (
            <ScopeView
              scopes={scopes}
              onRemove={(id) => editor?.removeScope(id)}
              onSettingsChange={(id, settings) =>
                editor?.updateScope(id, settings)
              }
            />
          ) : (
            <AnalysisContent />
          )}
        </div>
      </Tabs>
    </section>
  );
}
