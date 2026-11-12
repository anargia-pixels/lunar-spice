import {
  ChartLineData01Icon,
  Copy01Icon,
  Delete02Icon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  HelpCircleIcon,
  MinusSignIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  Redo02Icon,
  RotateClockwiseIcon,
  RotateLeft01Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Hint } from "@lunar-spice/components/hint/hint";
import { RunIcon } from "@lunar-spice/components/run-icon/run-icon";
import { Button } from "@lunar-spice/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@lunar-spice/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lunar-spice/components/ui/dropdown-menu";
import { Separator } from "@lunar-spice/components/ui/separator";
import { toast } from "@lunar-spice/components/ui/toast";
import { Toggle } from "@lunar-spice/components/ui/toggle";
import type { OperatingPointResult } from "@lunar-spice/simulator/analyses";
import type { CircuitElement } from "@lunar-spice/simulator/element";
import { formatSi } from "@lunar-spice/simulator/units";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ADD_TO_SCOPE_LABEL, type Scope } from "../../lib/scope";
import { comboLabel, type ShortcutSection } from "../../lib/shortcuts";
import {
  type CanvasCommandId,
  commandForKey,
  commandKeys,
  commandLabel,
  commandText,
} from "./commands";
import type { DisplayOptions } from "./display-options";
import { EditorController } from "./editor-controller";
import { ElementDialog } from "./element-dialog";
import { ComboKeys, ShortcutsDialog } from "./shortcuts-dialog";
import type { SimulationStatus } from "./simulation-status";
import { ToolIcon } from "./tool-icons";
import { groupTools, SELECT_TOOL, TOOLS } from "./tools";

/** Keys a focused button, slider or list uses itself, so the canvas leaves them be. */
function isControlKey(key: string) {
  return (
    key.startsWith("Arrow") ||
    [" ", "Enter", "Tab", "Escape", "Delete", "Backspace"].includes(key)
  );
}

/** True when a key press belongs to a text field or an open dialog, not the canvas. */
function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, [role=dialog], [role=menu]") !==
        null)
  );
}

/**
 * Stretches a 28 px tool's hit area to 40 px tall. Its neighbors sit right beside it, so
 * the width stays.
 */
const TOOL_HIT_AREA =
  "relative after:absolute after:inset-x-0 after:-inset-y-1.5";

/** The same for a bar button, whose 1 px border the insets start inside of. */
const BUTTON_HIT_AREA =
  "relative after:absolute after:-inset-x-px after:-inset-y-1.75";

const PRIMARY_TOOLS = TOOLS.filter((tool) => tool.isPrimary);

const MORE_TOOLS = TOOLS.filter((tool) => !tool.isPrimary);

/** Every tool, grouped, so the menu holds the bar's parts as well as the rest. */
const MENU_GROUPS = groupTools(TOOLS);

/** The floating bar of tools: Select, the common parts, then More for the rest. */
function ToolBar({
  toolId,
  onToolChange,
}: {
  toolId: string;
  onToolChange: (id: string) => void;
}) {
  const moreTool = MORE_TOOLS.find((tool) => tool.id === toolId);

  return (
    <div
      role="toolbar"
      aria-label="Tools"
      className="bg-card rounded-group shadow-floating pointer-events-auto flex shrink-0 items-center gap-0.5 p-1"
    >
      {PRIMARY_TOOLS.map((tool) => {
        const [combo] = tool.keys;

        return (
          <div key={tool.id} className="flex items-center gap-0.5">
            <Hint
              label={tool.label}
              side="bottom"
              shortcut={combo ? comboLabel(combo) : undefined}
            >
              <Toggle
                size="icon-sm"
                aria-label={tool.label}
                className={TOOL_HIT_AREA}
                pressed={toolId === tool.id}
                onPressedChange={() => onToolChange(tool.id)}
              >
                <ToolIcon toolId={tool.id} />
              </Toggle>
            </Hint>
            {tool === SELECT_TOOL && (
              <Separator orientation="vertical" className="mx-1 h-5" />
            )}
          </div>
        );
      })}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <DropdownMenu>
        <Hint label="Components" side="bottom">
          <DropdownMenuTrigger
            render={
              <Toggle
                size="icon-sm"
                aria-label="Components"
                pressed={moreTool !== undefined}
              />
            }
          >
            <ToolIcon toolId={moreTool?.id ?? "more"} />
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-76">
          {MENU_GROUPS.map(({ title, tools }, index) => (
            <Fragment key={title}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{title}</DropdownMenuLabel>
                {tools.map((tool) => {
                  const [combo] = tool.keys;

                  return (
                    <DropdownMenuItem
                      key={tool.id}
                      onClick={() => onToolChange(tool.id)}
                    >
                      <ToolIcon toolId={tool.id} />
                      {tool.label}
                      {combo && (
                        <span className="ml-auto">
                          <ComboKeys combo={combo} />
                        </span>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Run, pause and reset with the simulated time, in the canvas's top-left corner. */
function RunControls({
  status,
  controller,
}: {
  status: SimulationStatus;
  controller: EditorController | null;
}) {
  const label = status.isRunning ? "Pause" : "Run";

  return (
    <div className="bg-card rounded-group shadow-floating pointer-events-auto flex shrink-0 items-center gap-1 p-1">
      <Hint label={label} side="bottom" shortcut={commandKeys("run")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className={BUTTON_HIT_AREA}
          onClick={() => controller?.toggleRunning()}
        >
          <RunIcon isRunning={status.isRunning} />
        </Button>
      </Hint>
      <Hint
        label={commandLabel("reset")}
        side="bottom"
        shortcut={commandKeys("reset")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reset simulation"
          className={BUTTON_HIT_AREA}
          onClick={() => controller?.resetSimulation()}
        >
          <HugeiconsIcon icon={RotateLeft01Icon} strokeWidth={2} />
        </Button>
      </Hint>
      <output
        aria-label="Simulated time"
        className="text-muted-foreground min-w-20 px-1 text-xs whitespace-nowrap tabular-nums"
      >
        t = {formatSi(status.time, "s", 4)}
      </output>
    </div>
  );
}

/** The gap between the canvas edge and its floating bars, in CSS pixels. */
const OVERLAY_GUTTER = 12;

/** An icon button in a floating bar, named and hinted by its command. */
function CommandButton({
  command,
  icon,
  disabled,
  onClick,
}: {
  command: CanvasCommandId;
  icon: typeof PlusSignIcon;
  disabled?: boolean;
  onClick: () => void;
}) {
  const label = commandLabel(command);

  return (
    <Hint label={label} side="top" shortcut={commandKeys(command)}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={BUTTON_HIT_AREA}
        disabled={disabled}
        onClick={onClick}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </Button>
    </Hint>
  );
}

/**
 * The schematic editor: a canvas with the tool bar, run controls, zoom and history
 * buttons, a readout of the hovered part, its context menu and its dialogs. It opens
 * `text` whenever `circuitKey` changes and reports edits through `onChange`; the
 * controller it hands to `onControllerChange` lets the app drive the simulation.
 * `aside` floats along the right edge; the bars and fitted drawings keep clear of it.
 */
export function CircuitEditor({
  circuitKey,
  text,
  display,
  status,
  operatingPoint,
  appShortcuts,
  aside,
  onControllerChange,
  onChange,
  onStatus,
  onScopesChange,
}: {
  circuitKey: string;
  text: string;
  display: DisplayOptions;
  /** The status the editor last reported through `onStatus`. */
  status: SimulationStatus;
  /** A DC analysis of the circuit as it is now, whose voltages tag its nets. */
  operatingPoint: OperatingPointResult | null;
  /** The app's own shortcuts, listed after the canvas's in the shortcuts dialog. */
  appShortcuts: readonly ShortcutSection[];
  aside?: ReactNode;
  onControllerChange: (controller: EditorController | null) => void;
  onChange: (text: string) => void;
  onStatus: (status: SimulationStatus) => void;
  onScopesChange: (scopes: readonly Scope[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  /** Canvas width the aside covers from the right edge, with its gutter; 0 without one. */
  const [asideInset, setAsideInset] = useState(0);
  const [controller, setController] = useState<EditorController | null>(null);
  const [toolId, setToolId] = useState<string>(SELECT_TOOL.id);
  const [selectionCount, setSelectionCount] = useState(0);
  const [looseEnds, setLooseEnds] = useState(0);
  const [isEmpty, setIsEmpty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [info, setInfo] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<CircuitElement | null>(null);
  const [menuTarget, setMenuTarget] = useState<CircuitElement | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // The controller keeps the callbacks it was made with, so they read the latest
  // props from this ref.
  const latest = useRef({
    text,
    display,
    onChange,
    onStatus,
    onScopesChange,
    onControllerChange,
  });

  useLayoutEffect(() => {
    latest.current = {
      text,
      display,
      onChange,
      onStatus,
      onScopesChange,
      onControllerChange,
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const editor = new EditorController(
      canvas,
      {
        onChange: (next) => latest.current.onChange(next),
        onStatus: (next) => latest.current.onStatus(next),
        onToolChange: setToolId,
        onSelectionChange: setSelectionCount,
        onLooseEndsChange: setLooseEnds,
        onEmptyChange: setIsEmpty,
        onZoomChange: setZoom,
        onHistoryChange: (canUndo, canRedo) => setHistory({ canUndo, canRedo }),
        onEditRequest: setEditing,
        onInfo: setInfo,
        onScopesChange: (scopes) => latest.current.onScopesChange(scopes),
        onHelpRequest: () => setIsHelpOpen(true),
        onClipboardError: (title) =>
          toast.add({
            type: "error",
            title,
            description: "The clipboard is not available.",
          }),
      },
      latest.current.display,
    );

    setController(editor);
    latest.current.onControllerChange(editor);

    return () => {
      editor.destroy();
      latest.current.onControllerChange(null);
    };
  }, []);

  useEffect(() => {
    controller?.open(latest.current.text);
  }, [controller, circuitKey]);

  useEffect(() => {
    controller?.setDisplay(display);
  }, [controller, display]);

  useEffect(() => {
    controller?.setOperatingPoint(operatingPoint);
  }, [controller, operatingPoint]);

  // Fitted drawings stay clear of the run, tool and zoom bars and the aside,
  // measured as they lay out.
  useEffect(() => {
    const container = containerRef.current;
    const topBar = topBarRef.current;
    const bottomBar = bottomBarRef.current;
    const aside = asideRef.current;

    if (!controller || !container || !topBar || !bottomBar || !aside) {
      return;
    }

    const measure = () => {
      const box = container.getBoundingClientRect();
      const { width } = aside.getBoundingClientRect();
      const right = width > 0 ? width + OVERLAY_GUTTER : 0;

      setAsideInset(right);
      controller.setInsets({
        top: topBar.getBoundingClientRect().bottom - box.top,
        bottom: box.bottom - bottomBar.getBoundingClientRect().top,
        right,
      });
    };

    const observer = new ResizeObserver(measure);

    for (const element of [container, topBar, bottomBar, aside]) {
      observer.observe(element);
    }

    return () => observer.disconnect();
  }, [controller]);

  // The bars and the empty-canvas note end where the aside begins.
  const asideStyle: CSSProperties &
    Record<"--aside-inset" | "--overlay-right", string> = {
    "--aside-inset": `${asideInset}px`,
    "--overlay-right": `${asideInset + OVERLAY_GUTTER}px`,
  };

  // Runs canvas shortcuts from anywhere on the page but text fields and dialogs.
  useEffect(() => {
    if (!controller) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }

      const isOnCanvas =
        event.target === controller.canvas || event.target === document.body;

      // Elsewhere, focused controls keep their own keys; letters and Ctrl still work.
      if (!isOnCanvas && isControlKey(event.key)) {
        return;
      }

      const command = commandForKey(event)?.id;

      // Copying highlighted text, such as results, stays the browser's job.
      if (
        (command === "copy" || command === "cut") &&
        window.getSelection()?.toString()
      ) {
        return;
      }

      // Ctrl+V pastes through the browser's paste event below, which hands over the
      // clipboard without asking; reading it from a key press makes Firefox prompt.
      if (command === "paste") {
        return;
      }

      if (controller.handleKeyDown(event)) {
        event.preventDefault();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => controller.handleKeyUp(event);

    // Pastes circuit lines at the pointer; text that holds none is left to the page.
    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }

      const text = event.clipboardData?.getData("text/plain") ?? "";

      if (controller.paste(text, false)) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("paste", handlePaste);
    };
  }, [controller]);

  // The tool bar centers on the canvas until it would cover the run controls.
  // Readout rows are keyed by quantity, such as `I`, so value changes keep them.
  return (
    <>
      <div
        ref={containerRef}
        style={asideStyle}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {/* Canvas and its context menu */}
        <ContextMenu>
          <ContextMenuTrigger
            className="size-full"
            onContextMenu={(event) => {
              // A right-click ends the wire being drawn instead of opening the menu.
              if (controller?.stopWiring()) {
                event.preventDefault();
                event.preventBaseUIHandler();

                return;
              }

              setMenuTarget(
                controller?.pickForMenu(event.clientX, event.clientY) ?? null,
              );
            }}
          >
            <canvas
              ref={canvasRef}
              tabIndex={0}
              aria-label="Schematic"
              className="block size-full touch-none outline-none"
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            {menuTarget ? (
              <>
                {selectionCount === 1 && (
                  <ContextMenuItem onClick={() => controller?.editSelection()}>
                    <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                    {commandLabel("edit")}
                    <ContextMenuShortcut>
                      {commandText("edit")}
                    </ContextMenuShortcut>
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  onClick={() => controller?.addScope(menuTarget)}
                >
                  <HugeiconsIcon icon={ChartLineData01Icon} strokeWidth={2} />
                  {ADD_TO_SCOPE_LABEL}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => controller?.rotateSelection(true)}
                >
                  <HugeiconsIcon icon={RotateClockwiseIcon} strokeWidth={2} />
                  {commandLabel("rotate-right")}
                  <ContextMenuShortcut>
                    {commandText("rotate-right")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => controller?.flipSelection("horizontal")}
                >
                  <HugeiconsIcon icon={FlipHorizontalIcon} strokeWidth={2} />
                  {commandLabel("flip-horizontal")}
                  <ContextMenuShortcut>
                    {commandText("flip-horizontal")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => controller?.flipSelection("vertical")}
                >
                  <HugeiconsIcon icon={FlipVerticalIcon} strokeWidth={2} />
                  {commandLabel("flip-vertical")}
                  <ContextMenuShortcut>
                    {commandText("flip-vertical")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => controller?.duplicateSelection()}
                >
                  <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                  {commandLabel("duplicate")}
                  <ContextMenuShortcut>
                    {commandText("duplicate")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => controller?.deleteSelection()}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {commandLabel("delete")}
                  <ContextMenuShortcut>
                    {commandText("delete")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem
                  onClick={() => controller?.pasteFromClipboard(false)}
                >
                  {commandLabel("paste")}
                  <ContextMenuShortcut>
                    {commandText("paste")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onClick={() => controller?.selectAll()}>
                  {commandLabel("select-all")}
                  <ContextMenuShortcut>
                    {commandText("select-all")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onClick={() => controller?.zoomToDrawing()}>
                  {commandLabel("zoom-drawing")}
                  <ContextMenuShortcut>
                    {commandText("zoom-drawing")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {/* How to start, while there is nothing on the canvas */}
        {isEmpty && (
          <p className="text-muted-foreground pointer-events-none absolute inset-y-0 right-(--aside-inset) left-0 m-auto h-fit max-w-sm px-6 text-center text-sm text-balance">
            Pick a component from the toolbar and click to place it. Click a pin
            to start a wire, or open an example from the File menu.
          </p>
        )}
        {/* Floating bars and errors over the top of the canvas */}
        <div className="pointer-events-none absolute top-3 right-(--overlay-right) left-3 flex flex-col items-center gap-2">
          <div ref={topBarRef} className="flex w-full items-start gap-2">
            <div className="flex flex-1">
              <RunControls status={status} controller={controller} />
            </div>
            <ToolBar
              toolId={toolId}
              onToolChange={(id) => controller?.setTool(id)}
            />
            <div className="flex-1" />
          </div>
          {status.error && (
            <div
              role="alert"
              className="bg-card text-destructive shadow-floating pointer-events-auto max-w-lg rounded-lg px-3 py-2 text-sm text-pretty"
            >
              {status.error}
            </div>
          )}
        </div>
        {/* Floating bars along the bottom of the canvas */}
        <div className="pointer-events-none absolute right-(--overlay-right) bottom-3 left-3 flex items-end gap-2">
          <div
            ref={bottomBarRef}
            className="bg-card rounded-group shadow-floating pointer-events-auto flex items-center p-1"
          >
            <CommandButton
              command="zoom-out"
              icon={MinusSignIcon}
              onClick={() => controller?.zoomOut()}
            />
            <Hint
              label={commandLabel("zoom-1")}
              side="top"
              shortcut={commandKeys("zoom-1")}
            >
              <Button
                variant="ghost"
                size="sm"
                className="min-w-14"
                onClick={() => controller?.zoomTo(1)}
              >
                <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
              </Button>
            </Hint>
            <CommandButton
              command="zoom-in"
              icon={PlusSignIcon}
              onClick={() => controller?.zoomIn()}
            />
          </div>
          <div className="bg-card rounded-group shadow-floating pointer-events-auto flex items-center p-1">
            <CommandButton
              command="undo"
              icon={Undo02Icon}
              disabled={!history.canUndo}
              onClick={() => controller?.undo()}
            />
            <CommandButton
              command="redo"
              icon={Redo02Icon}
              disabled={!history.canRedo}
              onClick={() => controller?.redo()}
            />
          </div>
          {/* As tall as the bars, so the notes sit on their middle line */}
          <div className="flex h-9 items-center gap-3 text-xs tabular-nums">
            {selectionCount > 0 && (
              <span className="text-muted-foreground">
                {selectionCount} selected
              </span>
            )}
            {looseEnds > 0 && (
              <output
                aria-label="Unconnected ends"
                title="Ends that join nothing are ringed on the schematic."
                className="text-destructive"
              >
                {looseEnds === 1
                  ? "1 unconnected end"
                  : `${looseEnds} unconnected ends`}
              </output>
            )}
          </div>
          <div className="flex-1" />
          {info && (
            <output
              aria-label="Readout"
              className="bg-card shadow-floating flex min-w-40 flex-col rounded-lg px-3 py-2 text-xs tabular-nums"
            >
              <span className="font-medium">{info[0]}</span>
              {info.slice(1).map((line) => (
                <span
                  key={line.split(" = ")[0]}
                  className="text-muted-foreground"
                >
                  {line}
                </span>
              ))}
            </output>
          )}
          <Hint
            label={commandLabel("help")}
            side="top"
            shortcut={commandKeys("help")}
          >
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={commandLabel("help")}
              className="pointer-events-auto relative after:absolute after:-inset-1.75"
              onClick={() => setIsHelpOpen(true)}
            >
              <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} />
            </Button>
          </Hint>
        </div>
        {/* The aside, such as a settings panel, along the right edge */}
        <div
          ref={asideRef}
          className="pointer-events-none absolute inset-y-3 right-3 flex"
        >
          {aside}
        </div>
      </div>
      {/* Dialogs */}
      <ElementDialog
        element={editing}
        onClose={() => setEditing(null)}
        onSave={(original, replacement) =>
          controller?.replaceElement(original, replacement)
        }
      />
      <ShortcutsDialog
        open={isHelpOpen}
        onOpenChange={setIsHelpOpen}
        appSections={appShortcuts}
      />
    </>
  );
}
