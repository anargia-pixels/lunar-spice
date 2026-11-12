import { CircuitEditor } from "@lunar-spice/components/circuit-editor/circuit-editor";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@lunar-spice/components/ui/resizable";

import { appShortcutSections } from "../lib/app-commands";
import { useAppearanceStore } from "../stores/appearance-store";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useLayoutStore } from "../stores/layout-store";
import { useSimulationStore } from "../stores/simulation-store";
import { ResultsPanel } from "./results-panel";
import { SimulationPanel } from "./simulation-panel";

/** The least the canvas keeps when the results panel is dragged up, in CSS pixels. */
const CANVAS_MIN_HEIGHT = 200;

/** The least the results panel shrinks to: its tabs and one readable plot. */
const RESULTS_MIN_HEIGHT = 160;

/**
 * The editor for the active circuit with the simulation panel floating over it, above
 * the results panel when that is open.
 */
export function EditorPage() {
  // An edit changes only the text, which the mounted editor already owns, so the page
  // re-renders only when another circuit opens.
  const bufferId = useCircuitStore((state) => activeBuffer(state)?.id);

  const display = useAppearanceStore((state) => state.display);
  const status = useSimulationStore((state) => state.status);

  // A DC result of this circuit labels its nets while the text stays the same.
  const operatingPoint = useSimulationStore((state) =>
    state.result?.kind === "dc" && state.resultCircuitId === bufferId
      ? state.result
      : null,
  );

  const resultText = useSimulationStore((state) => state.resultText);

  const isResultCurrent = useCircuitStore(
    (state) => activeBuffer(state)?.text === resultText,
  );

  const isPanelOpen = useLayoutStore((state) => state.panelOpen);
  const isResultsOpen = useLayoutStore((state) => state.resultsOpen);
  const { setEditor, setStatus, setScopes } = useSimulationStore.getState();

  if (bufferId === undefined) {
    return null;
  }

  // The editor reads the text once per circuit; a new `circuitKey` reloads it.
  const text = activeBuffer(useCircuitStore.getState())?.text ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The canvas above the results, which a drag on the line between them sizes */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel
          id="canvas"
          minSize={CANVAS_MIN_HEIGHT}
          className="flex flex-col"
        >
          <CircuitEditor
            circuitKey={bufferId}
            text={text}
            display={display}
            status={status}
            operatingPoint={isResultCurrent ? operatingPoint : null}
            appShortcuts={appShortcutSections()}
            aside={isPanelOpen ? <SimulationPanel /> : null}
            onControllerChange={setEditor}
            onChange={(next) =>
              useCircuitStore.getState().setText(bufferId, next)
            }
            onStatus={setStatus}
            onScopesChange={setScopes}
          />
        </ResizablePanel>
        {isResultsOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel
              id="results"
              defaultSize={useLayoutStore.getState().resultsHeight}
              minSize={RESULTS_MIN_HEIGHT}
              groupResizeBehavior="preserve-pixel-size"
              onResize={({ inPixels }) =>
                useLayoutStore.getState().setResultsHeight(inPixels)
              }
            >
              <ResultsPanel key={bufferId} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
