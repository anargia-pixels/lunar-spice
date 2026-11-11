import { SidebarRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CircuitEditor } from "@lunar-spice/components/circuit-editor/circuit-editor";
import { Hint } from "@lunar-spice/components/hint/hint";
import { Button } from "@lunar-spice/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@lunar-spice/components/ui/resizable";
import { SidebarTrigger } from "@lunar-spice/components/ui/sidebar";
import { useShallow } from "zustand/react/shallow";

import { appShortcutKeys, appShortcutSections } from "../lib/app-commands";
import { CIRCUIT_EXTENSION } from "../lib/circuit-files";
import { useAppearanceStore } from "../stores/appearance-store";
import { activeBuffer, useCircuitStore } from "../stores/circuit-store";
import { useSidebarStore } from "../stores/sidebar-store";
import { useSimulationStore } from "../stores/simulation-store";
import { ResultsPanel } from "./results-panel";

/** The least the canvas keeps when the results panel is dragged up, in CSS pixels. */
const CANVAS_MIN_HEIGHT = 200;

/** The least the results panel shrinks to: its tabs and one readable plot. */
const RESULTS_MIN_HEIGHT = 160;

/** The editor for the active circuit, under a header with its file name. */
export function EditorPage() {
  // An edit changes only the text, which the mounted editor already owns, so
  // the page re-renders only when the buffer or its saved state changes.
  const buffer = useCircuitStore(
    useShallow((state) => {
      const active = activeBuffer(state);

      return active
        ? {
            id: active.id,
            title: active.title,
            fileName: active.fileName,
            isDirty: active.text !== active.savedText,
          }
        : null;
    }),
  );

  const display = useAppearanceStore((state) => state.display);
  const status = useSimulationStore((state) => state.status);

  // A DC result of this circuit labels its nets while the text stays the same.
  const operatingPoint = useSimulationStore((state) =>
    state.result?.kind === "dc" && state.resultCircuitId === buffer?.id
      ? state.result
      : null,
  );

  const resultText = useSimulationStore((state) => state.resultText);

  const isResultCurrent = useCircuitStore(
    (state) => activeBuffer(state)?.text === resultText,
  );

  const togglePanel = useSidebarStore((state) => state.toggles.panel);
  const isResultsOpen = useSidebarStore((state) => state.resultsOpen);
  const { setEditor, setStatus, setScopes } = useSimulationStore.getState();

  if (!buffer) {
    return null;
  }

  const fileName = buffer.fileName ?? `${buffer.title}${CIRCUIT_EXTENSION}`;

  // The editor reads the text once per circuit; a new `circuitKey` reloads it.
  const text = activeBuffer(useCircuitStore.getState())?.text ?? "";

  return (
    <div className="flex h-svh flex-col">
      <header className="relative flex h-10 shrink-0 items-center justify-center border-b px-12 text-xs select-none">
        <Hint
          label="Toggle sidebar"
          side="bottom"
          shortcut={appShortcutKeys("toggle-sidebar")}
        >
          <SidebarTrigger className="absolute left-3 after:absolute after:-inset-1.75" />
        </Hint>
        <span
          aria-label="File path"
          title={fileName}
          className="max-w-3xl min-w-0 truncate text-center"
        >
          lunar-spice / {fileName}
        </span>
        <output className="text-muted-foreground ml-1 shrink-0">
          {buffer.fileName === null
            ? "- Not saved"
            : buffer.isDirty
              ? "- Unsaved changes"
              : null}
        </output>
        <Hint
          label="Toggle simulation panel"
          side="bottom"
          shortcut={appShortcutKeys("toggle-panel")}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle simulation panel"
            className="absolute right-3 after:absolute after:-inset-1.75"
            onClick={togglePanel}
          >
            <HugeiconsIcon icon={SidebarRightIcon} strokeWidth={2} />
          </Button>
        </Hint>
      </header>
      {/* The canvas above the results, which a drag on the line between them sizes */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel
          id="canvas"
          minSize={CANVAS_MIN_HEIGHT}
          className="flex flex-col"
        >
          <CircuitEditor
            circuitKey={buffer.id}
            text={text}
            display={display}
            status={status}
            operatingPoint={isResultCurrent ? operatingPoint : null}
            appShortcuts={appShortcutSections()}
            onControllerChange={setEditor}
            onChange={(next) =>
              useCircuitStore.getState().setText(buffer.id, next)
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
              defaultSize={useSidebarStore.getState().resultsHeight}
              minSize={RESULTS_MIN_HEIGHT}
              groupResizeBehavior="preserve-pixel-size"
              onResize={({ inPixels }) =>
                useSidebarStore.getState().setResultsHeight(inPixels)
              }
            >
              <ResultsPanel key={buffer.id} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
