import type { OperatingPointResult } from "@lunar-spice/simulator/analyses";
import {
  assignDesignators,
  Circuit,
  cloneElement,
  createElement,
  readElementLine,
  type SimulationSettings,
} from "@lunar-spice/simulator/circuit";
import type {
  CircuitElement,
  ElementKind,
} from "@lunar-spice/simulator/element";
import {
  Oscilloscope,
  type OscilloscopeSettings,
} from "@lunar-spice/simulator/elements/oscilloscope";
import {
  GRID_SIZE,
  type Point,
  pointKey,
  snapToGrid,
} from "@lunar-spice/simulator/geometry";
import {
  type Bounds,
  boundsOf,
  boundsOfElements,
  cornerOfElements,
  distanceToElement,
  flipElements,
  isInside,
  rotateElements,
  withEnclosed,
} from "@lunar-spice/simulator/layout";
import {
  isOnWire,
  joinPostsToWires,
  mergeWires,
} from "@lunar-spice/simulator/wiring";

import { canvasPalette, watchPalette } from "../../lib/canvas-palette";
import type { OscilloscopeEntry } from "../../lib/oscilloscope-feed";
import type { Scope, ScopeSettings } from "../../lib/scope";
import { AttachedWires } from "./attached-wires";
import { Camera, type Insets } from "./camera";
import { commandForKey } from "./commands";
import type { DisplayOptions } from "./display-options";
import { type DrawOptions, SchematicPainter } from "./draw-elements";
import {
  EditorHistory,
  restoreSnapshot,
  type Snapshot,
  snapshotOf,
} from "./editor-history";
import { InteractiveRun } from "./interactive-run";
import { type PostPoint, renderScene } from "./render-scene";
import { selectionImage } from "./selection-image";
import type { SimulationStatus } from "./simulation-status";
import { findTool, SELECT_TOOL, type Tool, toolForKey } from "./tools";

/** A selected part's wiper, which the canvas offers a slider for. */
export type SelectedWiper = {
  /** The part's designator, such as `RV1`, or its name before it has one. */
  name: string;
  /** From 0 to 1 along the track. */
  position: number;
};

/** Everything the editor tells the app about. */
export type EditorCallbacks = {
  /** After every committed edit, with the circuit in its file format. */
  onChange: (text: string) => void;
  onStatus: (status: SimulationStatus) => void;
  onToolChange: (toolId: string) => void;
  onSelectionChange: (count: number) => void;
  onZoomChange: (scale: number) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  /** The element to open in the properties dialog. */
  onEditRequest: (element: CircuitElement) => void;
  /** Readout lines for the hovered or selected element; null when there is none. */
  onInfo: (lines: string[] | null) => void;
  /** The wiper of the only selected element, such as a potentiometer; null when it has none. */
  onWiperChange: (wiper: SelectedWiper | null) => void;
  onScopesChange: (scopes: readonly Scope[]) => void;
  /** After an oscilloscope comes, goes, is renamed or has its front panel changed. */
  onOscilloscopesChange: (oscilloscopes: readonly OscilloscopeEntry[]) => void;
  /** Whether the circuit has no elements yet, so the canvas can say how to start. */
  onEmptyChange: (isEmpty: boolean) => void;
  /** How many posts join nothing, which is how a circuit most often comes out wrong. */
  onLooseEndsChange: (count: number) => void;
  /** Asks the app to open the shortcuts dialog. */
  onHelpRequest: () => void;
  /** Reports a failed clipboard read or write; `message` titles the error. */
  onClipboardError: (message: string) => void;
  /** Reports a finished clipboard write the user cannot see; `message` titles it. */
  onClipboardCopied: (message: string) => void;
};

/** Inkscape's zoom step for + and −. */
const ZOOM_STEP = Math.SQRT2;

/** Schematic units within which a click picks an element or its end. */
const PICK_DISTANCE = 8;

/** Schematic units within which a wire wins a click over the part it runs beside. */
const WIRE_PREFERENCE = 4;

/** Schematic units within which a click on a post starts a wire from it. */
const POST_PICK_DISTANCE = 5;

/** Schematic units around a label's text that still pick it. */
const LABEL_PICK_MARGIN = 2;

/** What a click on a post draws with the select tool, as in Multisim. */
const WIRE_KIND: ElementKind = "wire";

/** The readout refreshes at most this often while the simulation runs. */
const INFO_INTERVAL_MS = 100;

/** How far a duplicate lands from its original. */
const DUPLICATE_OFFSET = 2 * GRID_SIZE;

/** Wheel zoom per pixel of scroll, as an exponent. */
const WHEEL_ZOOM_RATE = 0.0025;

/** Elapsed time assumed for the first frame, which has no previous one. */
const FIRST_FRAME_MS = 16;

/** How long loose ends stay flagged after the canvas is asked to show them. */
const LOOSE_END_FLASH_MS = 2400;

/** Room kept around loose ends brought into view, so their parts show too. */
const LOOSE_END_MARGIN = 4 * GRID_SIZE;

/**
 * The gesture between a press and its release: panning, moving the selection with the
 * wires attached to it, dragging a wire's end or a part's label, a rubber band, or
 * holding a push switch.
 */
type Drag =
  | { kind: "pan"; start: Point; scrolled: Point }
  | {
      kind: "move";
      before: Snapshot;
      origin: Point;
      applied: Point;
      /** The selection and what its groups hold. */
      moved: ReadonlySet<CircuitElement>;
      wires: AttachedWires;
      hasMoved: boolean;
      clicked: CircuitElement;
    }
  | {
      kind: "label";
      before: Snapshot;
      element: CircuitElement;
      origin: Point;
      startOffset: Point;
      hasMoved: boolean;
    }
  | {
      kind: "end";
      before: Snapshot;
      element: CircuitElement;
      isStart: boolean;
      hasMoved: boolean;
    }
  | { kind: "band"; origin: Point; current: Point; isAdditive: boolean }
  | { kind: "press"; element: CircuitElement };

/**
 * A wire being routed, as in Multisim and EasyEDA: it runs from `anchor` to the pointer
 * along the grid with one bend, each click fixes it and starts the next stretch there,
 * and a click on a post or a wire ends it.
 */
type Wiring = {
  kind: ElementKind;
  anchor: Point;
  /** Whether it leaves the anchor sideways; null until the pointer leaves the anchor. */
  isHorizontalFirst: boolean | null;
  /** The stretch from the anchor to the pointer, not yet in the circuit. */
  preview: CircuitElement[];
  /** True while the press that started it is down, so that a drag draws a wire too. */
  isPressHeld: boolean;
};

/** The box between two corners, in either order. */
function boxBetween(a: Point, b: Point): Bounds {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** True for a wire, which keeps its net's moved tag. */
function isWire(element: CircuitElement) {
  return element.isNetElement() && element.isConductor();
}

/** The wire whose label offset places its net's moved tag; null while it sits unmoved. */
function tagHolder(wires: readonly CircuitElement[]) {
  return (
    wires.find(
      ({ labelOffset }) => labelOffset.x !== 0 || labelOffset.y !== 0,
    ) ?? null
  );
}

/** True when `point` is on a label's `box`, give or take the pick margin. */
function isOnLabel(point: Point, box: Bounds) {
  return (
    point.x >= box.left - LABEL_PICK_MARGIN &&
    point.x <= box.right + LABEL_PICK_MARGIN &&
    point.y >= box.top - LABEL_PICK_MARGIN &&
    point.y <= box.bottom + LABEL_PICK_MARGIN
  );
}

function snapped(point: Point): Point {
  return { x: snapToGrid(point.x), y: snapToGrid(point.y) };
}

/**
 * Owns the schematic on one canvas: the circuit, its selection, placement and editing
 * gestures, and the keyboard. The camera, undo history and interactive simulation are
 * its collaborators; the React wrapper only mounts it and forwards events.
 */
export class EditorController {
  readonly canvas: HTMLCanvasElement;
  private readonly callbacks: EditorCallbacks;
  private readonly painter: SchematicPainter;
  private readonly camera: Camera;
  private readonly history: EditorHistory;
  private readonly run: InteractiveRun;
  private circuit = new Circuit();
  private display: DisplayOptions;
  private tool: Tool = SELECT_TOOL;
  private selection = new Set<CircuitElement>();
  private hovered: CircuitElement | null = null;
  private drag: Drag | null = null;
  private wiring: Wiring | null = null;
  /** The post under the pointer that a click with the select tool would wire from. */
  private hoveredPost: Point | null = null;
  /** Posts that join nothing, ringed on the schematic. */
  private looseEnds: Point[] = [];
  /** When the canvas was last asked to show the loose ends, in frame time. */
  private looseEndsShownAt = Number.NEGATIVE_INFINITY;
  /** True while loose ends are flagged, so each frame redraws them. */
  private isFlashingLooseEnds = false;
  /** The part a placing tool shows under the pointer; a click drops a copy of it. */
  private ghost: CircuitElement | null = null;
  private isPointerInside = false;
  private pointer: Point = { x: 0, y: 0 };
  private isSpaceHeld = false;
  /** True while the pointer rests on a part's label, which a drag moves. */
  private isOverLabel = false;
  private posts: PostPoint[] = [];
  /** Net voltages by net name from a DC analysis of this circuit, tagged on its nets. */
  private netVoltages: ReadonlyMap<string, number> | null = null;
  private frame = 0;
  private lastFrameTime = 0;
  private lastInfoTime = 0;
  private isDirty = true;
  /** True while a slider turns a wiper, so the whole turn is one undo step. */
  private isTurningWiper = false;
  /** True when a wiper moved since the simulation last heard of it. */
  private hasWiperMoved = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: EditorCallbacks,
    display: DisplayOptions,
  ) {
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas 2D is not available.");
    }

    this.canvas = canvas;
    this.callbacks = callbacks;
    this.display = display;
    this.camera = new Camera(
      (scale) => {
        callbacks.onZoomChange(scale);
        this.invalidate();
      },
      () => boundsOfElements(this.circuit.elements),
    );
    this.history = new EditorHistory(callbacks.onHistoryChange);
    this.run = new InteractiveRun({
      onStatus: callbacks.onStatus,
      onScopesChange: callbacks.onScopesChange,
      onOscilloscopesChange: callbacks.onOscilloscopesChange,
    });
    this.painter = new SchematicPainter(context, this.drawOptions());
    this.attach();
    this.loadSchematicFont();
    this.frame = requestAnimationFrame(this.tick);
  }

  private drawOptions(): DrawOptions {
    return {
      ...this.display,
      palette: canvasPalette(),
      voltageRange: this.circuit.settings.voltageRange,
    };
  }

  /** Redraws on the next frame. */
  private invalidate() {
    this.isDirty = true;
  }

  // Lifecycle

  /** Listens to the canvas's pointer, wheel and size changes, and to the theme. */
  private attach() {
    const { canvas } = this;

    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      canvas.addEventListener(type, handler);
      this.cleanups.push(() => canvas.removeEventListener(type, handler));
    };

    listen("pointerdown", (event) => this.handlePointerDown(event));
    listen("pointermove", (event) => this.handlePointerMove(event));
    listen("pointerup", (event) => this.handlePointerUp(event));
    listen("pointercancel", (event) => this.handlePointerUp(event));
    listen("pointerleave", () => {
      this.isPointerInside = false;
      this.setHovered(null);
      this.setHoveredPost(null);
      this.invalidate();
    });
    listen("dblclick", () => this.editSelection());
    listen("wheel", (event) => this.handleWheel(event));

    const resize = new ResizeObserver(() => this.resize());

    resize.observe(canvas);
    this.cleanups.push(() => resize.disconnect());
    this.cleanups.push(watchPalette(() => this.updatePainter()));
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.run.destroy();

    for (const cleanup of this.cleanups) {
      cleanup();
    }
  }

  /** Hands the painter the latest display options, palette and voltage range. */
  private updatePainter() {
    this.painter.setOptions(this.drawOptions());
    this.invalidate();
  }

  private resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();

    // Resizing a canvas clears it, so it redraws even when the view stays put.
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.camera.resize(width, height);
    this.invalidate();
  }

  // State menus read when they open, so they need no callbacks of their own.

  get canUndo() {
    return this.history.canUndo;
  }

  get canRedo() {
    return this.history.canRedo;
  }

  get selectionCount() {
    return this.selection.size;
  }

  get toolId() {
    return this.tool.id;
  }

  /** The canvas edges the floating controls cover, which fitted drawings stay clear of. */
  setInsets(insets: Insets) {
    this.camera.setInsets(insets);
  }

  // Document

  /**
   * Opens another circuit: fits it in view, clears the history and starts from 0 s. A
   * file whose wires only touch the posts they should join is reported back joined.
   */
  open(text: string) {
    this.circuit = Circuit.parse(text);

    const hasJoined = this.joinWires();

    this.clearInteraction();
    this.history.clear();
    this.run.start(this.circuit);
    this.camera.fitDrawing();
    this.afterDocumentChange();

    if (hasJoined) {
      this.callbacks.onChange(this.circuit.dump());
    }
  }

  /**
   * Merges overlapping wires, and wires meeting in line with nothing else at the joint,
   * then joins posts that touch a wire between its ends; true when any wire changed.
   */
  private joinWires() {
    const joined = joinPostsToWires(mergeWires(this.circuit.elements));

    if (joined === this.circuit.elements) {
      return false;
    }

    this.circuit.elements = [...joined];

    // A wire merged into another leaves the selection.
    const kept = new Set(joined);

    this.selection = new Set(
      [...this.selection].filter((element) => kept.has(element)),
    );

    if (this.hovered && !kept.has(this.hovered)) {
      this.hovered = null;
    }

    return true;
  }

  /**
   * Goes back to the elements in `snapshot`, keeping the simulation settings and each
   * oscilloscope's front panel, which stay out of the history alike.
   */
  private restore(snapshot: Snapshot) {
    const panels = new Map(
      this.circuit.elements.flatMap((element) =>
        element instanceof Oscilloscope
          ? [[element.id, element.settings] as const]
          : [],
      ),
    );

    this.circuit.elements = restoreSnapshot(snapshot);

    for (const element of this.circuit.elements) {
      const settings = panels.get(element.id);

      if (element instanceof Oscilloscope && settings) {
        element.settings = settings;
      }
    }

    this.clearInteraction();
    this.commit();
  }

  private clearInteraction() {
    this.selection.clear();
    this.hovered = null;
    this.hoveredPost = null;
    this.drag = null;
    this.wiring = null;
  }

  /** Refreshes what depends on the elements: junctions, painter, selection and readout. */
  private afterDocumentChange() {
    this.callbacks.onEmptyChange(this.circuit.elements.length === 0);
    this.countPosts();
    this.updatePainter();
    this.emitSelection();
  }

  /**
   * Changes simulation settings stored in the circuit file. Sliders change them many
   * times a second, so they stay out of the undo history.
   */
  updateSettings(settings: Partial<SimulationSettings>) {
    this.circuit.settings = { ...this.circuit.settings, ...settings };
    this.run.updateSettings();
    this.updatePainter();
    this.callbacks.onChange(this.circuit.dump());
  }

  /**
   * Changes an oscilloscope's front panel, which its file line stores. Knobs turn many
   * times a second, so like the simulation settings it stays out of the undo history.
   */
  updateOscilloscope(elementId: number, settings: OscilloscopeSettings) {
    const element = this.circuit.elements.find(({ id }) => id === elementId);

    if (!(element instanceof Oscilloscope)) {
      return;
    }

    element.settings = settings;
    this.run.updateOscilloscopes();
    this.callbacks.onChange(this.circuit.dump());
  }

  setDisplay(display: DisplayOptions) {
    this.display = display;
    this.updatePainter();
    this.loadSchematicFont();
  }

  /**
   * Fetches the mono schematic font when it is chosen, then redraws. Nothing else on the
   * page uses it, so the browser would not load it for the canvas on its own.
   */
  private loadSchematicFont() {
    if (this.display.schematicFont !== "mono" || !("fonts" in document)) {
      return;
    }

    // Sample text covering each subset labels need, Greek for Ω included.
    void document.fonts
      .load(`11px ${canvasPalette().schematicMonoFamily}`, "R1 4.7 kΩ µF")
      .then(() => this.invalidate());
  }

  /** Tags each net with its voltage in `result`; null removes the tags. */
  setOperatingPoint(result: OperatingPointResult | null) {
    this.netVoltages =
      result &&
      new Map(
        result.nets.flatMap(({ net, voltage }) =>
          net === null ? [] : [[net, voltage] as const],
        ),
      );
    this.invalidate();
  }

  /** Saves the state before an edit so undo can restore it. */
  private checkpoint() {
    this.history.record(snapshotOf(this.circuit.elements));
  }

  /**
   * Finishes an edit: joins wires to the posts dropped on them, renumbers, rebuilds the
   * simulation and reports the new file.
   */
  private commit() {
    this.joinWires();
    assignDesignators(this.circuit.elements);
    this.run.rebuild(this.circuit);
    this.afterDocumentChange();
    this.callbacks.onChange(this.circuit.dump());
  }

  undo() {
    const snapshot = this.history.undo(snapshotOf(this.circuit.elements));

    if (snapshot) {
      this.restore(snapshot);
    }
  }

  redo() {
    const snapshot = this.history.redo(snapshotOf(this.circuit.elements));

    if (snapshot) {
      this.restore(snapshot);
    }
  }

  // Simulation

  toggleRunning() {
    this.run.toggleRunning();
  }

  resetSimulation() {
    this.run.reset(this.circuit);
  }

  /** Watches an element in a scope; a wire or net label watches its net. */
  addScope(element: CircuitElement) {
    this.run.addScope(element);
  }

  removeScope(elementId: number) {
    this.run.removeScope(elementId);
  }

  updateScope(elementId: number, settings: Partial<ScopeSettings>) {
    this.run.updateScope(elementId, settings);
  }

  // Selection

  /** Reports the selection count, the readout and the selected wiper, and redraws. */
  private emitSelection() {
    this.callbacks.onSelectionChange(this.selection.size);
    this.emitInfo(true);
    this.emitWiper();
    this.invalidate();
  }

  /** The only selected element when it has a wiper; null otherwise. */
  private get wiperElement() {
    const [selected] = this.selection.size === 1 ? this.selection : [];

    return selected === undefined || selected.wiperPosition() === null
      ? null
      : selected;
  }

  private emitWiper() {
    const element = this.wiperElement;
    const position = element?.wiperPosition() ?? null;

    this.callbacks.onWiperChange(
      element === null || position === null
        ? null
        : { name: element.designator || element.name(), position },
    );
  }

  /**
   * Moves the selected part's wiper to `position`, from 0 to 1, while the simulation
   * runs on. A slider calls this many times a second, so the simulation hears of it once
   * a frame, and the turn is one undo step until `finishTurningWiper`.
   */
  turnWiper(position: number) {
    const element = this.wiperElement;

    if (!element) {
      return;
    }

    if (!this.isTurningWiper) {
      this.checkpoint();
      this.isTurningWiper = true;
    }

    element.setWiperPosition(position);
    this.hasWiperMoved = true;
    this.emitInfo(true);
    this.emitWiper();
    this.invalidate();
  }

  /** Ends a turn of the wiper; the next one is another undo step. */
  finishTurningWiper() {
    this.isTurningWiper = false;
  }

  private get selectedElements() {
    return this.circuit.elements.filter((element) =>
      this.selection.has(element),
    );
  }

  /**
   * The selection with everything inside its groups, in file order: what moving, copying
   * and deleting act on.
   */
  private get affectedElements() {
    return withEnclosed(this.selectedElements, this.circuit.elements);
  }

  /** True when the selection holds a group, which Ungroup removes. */
  get hasGroupSelected() {
    return [...this.selection].some((element) => element.isEnclosure());
  }

  /**
   * Draws a group around the selection, a grid step clear of it, and selects the group,
   * as Excalidraw wraps a selection in a frame. The group goes first in the file, so it
   * draws beneath what it holds.
   */
  groupSelection() {
    const bounds = boundsOfElements(this.selectedElements);

    if (!bounds) {
      return;
    }

    const group = createElement(
      "group",
      Math.floor(bounds.left / GRID_SIZE - 1) * GRID_SIZE,
      Math.floor(bounds.top / GRID_SIZE - 1) * GRID_SIZE,
      Math.ceil(bounds.right / GRID_SIZE + 1) * GRID_SIZE,
      Math.ceil(bounds.bottom / GRID_SIZE + 1) * GRID_SIZE,
    );

    this.checkpoint();
    this.circuit.elements.unshift(group);
    this.selection = new Set([group]);
    this.commit();
  }

  /** Removes the selected groups, keeping what they held, which becomes the selection. */
  ungroupSelection() {
    const groups = this.selectedElements.filter((element) =>
      element.isEnclosure(),
    );

    if (groups.length === 0) {
      return;
    }

    const held = withEnclosed(groups, this.circuit.elements).filter(
      (element) => !groups.includes(element),
    );

    this.checkpoint();
    this.circuit.elements = this.circuit.elements.filter(
      (element) => !groups.includes(element),
    );
    this.selection = new Set(held);
    this.commit();
  }

  private select(elements: readonly CircuitElement[]) {
    this.selection = new Set(elements);
    this.emitSelection();
  }

  selectAll() {
    this.select(this.circuit.elements);
  }

  /** Selects the next element in file order, or the previous one; Tab in Inkscape. */
  cycleSelection(isBackward: boolean) {
    const { elements } = this.circuit;
    const [current] = this.selectedElements;

    if (elements.length === 0) {
      return;
    }

    const step = isBackward ? -1 : 1;

    // With nothing selected, Tab starts at the first element and Shift+Tab at
    // the last.
    const index = current
      ? (elements.indexOf(current) + step + elements.length) % elements.length
      : isBackward
        ? elements.length - 1
        : 0;

    const next = elements[index];

    this.select(next ? [next] : []);
  }

  /**
   * Picks the element under a viewport point for a context menu. An element outside the
   * selection becomes the whole selection, so the menu acts on what was clicked.
   */
  pickForMenu(clientX: number, clientY: number) {
    const element = this.elementAt(this.toWorld(clientX, clientY));

    if (!element || !this.selection.has(element)) {
      this.select(element ? [element] : []);
    }

    return element;
  }

  /** Stops a wire being drawn, leaves a placing tool, or else deselects. */
  escape() {
    if (this.stopWiring()) {
      return;
    }

    if (this.tool.kind) {
      this.setTool(SELECT_TOOL.id);
    } else {
      this.select([]);
    }
  }

  requestHelp() {
    this.callbacks.onHelpRequest();
  }

  // Tools

  /** Switches to the tool with `id`; an unknown id changes nothing. */
  setTool(id: string) {
    const tool = findTool(id);

    if (!tool) {
      return;
    }

    this.tool = tool;
    this.drag = null;
    this.wiring = null;
    this.ghost = this.newGhost(tool);
    this.updateCursor();
    this.callbacks.onToolChange(tool.id);
    this.invalidate();
  }

  private updateCursor() {
    this.canvas.style.cursor =
      this.drag?.kind === "pan"
        ? "grabbing"
        : this.isSpaceHeld
          ? "grab"
          : this.tool.kind || this.wiring || this.hoveredPost
            ? "crosshair"
            : this.isOverLabel || this.drag?.kind === "label"
              ? "move"
              : "default";
  }

  /**
   * A part for `tool` at its fixed size, its first post on the pointer's grid point.
   * Null for the select tool and for parts drawn by dragging, which stretch.
   */
  private newGhost(tool: Tool) {
    if (!tool.kind) {
      return null;
    }

    const at = snapped(this.pointer);

    const element = createElement(
      tool.kind,
      at.x,
      at.y,
      at.x + tool.size.dx,
      at.y + tool.size.dy,
    );

    tool.configure?.(element);

    return element.isStretchable() ? null : element;
  }

  /** Keeps the part being placed under the pointer. */
  private moveGhost() {
    const { ghost } = this;

    if (ghost) {
      const at = snapped(this.pointer);

      ghost.translate(at.x - ghost.x1, at.y - ghost.y1);
      this.invalidate();
    }
  }

  /** Drops the part under the pointer and keeps a copy there, turned the same way. */
  private placeGhost(ghost: CircuitElement) {
    this.moveGhost();
    this.ghost = cloneElement(ghost);
    this.add([ghost]);
  }

  /** Adds `elements` as one undo step and selects them, unless `shouldSelect` is false. */
  private add(elements: readonly CircuitElement[], shouldSelect = true) {
    this.checkpoint();
    this.circuit.elements.push(...elements);
    this.selection = new Set(shouldSelect ? elements : []);
    this.commit();
  }

  // Wiring

  /** The post within reach of `point`, nearest first; null when there is none. */
  private postAt(point: Point) {
    let best: Point | null = null;
    let bestDistance = POST_PICK_DISTANCE;

    for (const { point: post } of this.posts) {
      const distance = Math.hypot(post.x - point.x, post.y - point.y);

      if (distance <= bestDistance) {
        best = post;
        bestDistance = distance;
      }
    }

    return best;
  }

  /** True when a wire that ends at `point` joins something: a post or another wire. */
  private isConnection(point: Point) {
    return (
      this.posts.some(
        ({ point: post }) => post.x === point.x && post.y === point.y,
      ) || isOnWire(this.circuit.elements, point)
    );
  }

  /** Starts a wire at `anchor`; the press that starts it is still down. */
  private startWiring(anchor: Point, kind: ElementKind) {
    this.wiring = {
      kind,
      anchor,
      isHorizontalFirst: null,
      preview: [],
      isPressHeld: true,
    };
    this.updateCursor();
  }

  /**
   * Routes the wire being drawn to `at`: straight when it lines up with the anchor, else
   * with one bend. It leaves the anchor along the axis the pointer first moved on.
   */
  private routeWiring(wiring: Wiring, at: Point) {
    const { anchor, kind } = wiring;
    const dx = at.x - anchor.x;
    const dy = at.y - anchor.y;

    if (dx === 0 && dy === 0) {
      wiring.isHorizontalFirst = null;
      wiring.preview = [];

      return;
    }

    wiring.isHorizontalFirst ??= Math.abs(dx) >= Math.abs(dy);

    const corner = wiring.isHorizontalFirst
      ? { x: at.x, y: anchor.y }
      : { x: anchor.x, y: at.y };

    wiring.preview = [[anchor, corner] as const, [corner, at] as const].flatMap(
      ([from, to]) =>
        from.x === to.x && from.y === to.y
          ? []
          : [createElement(kind, from.x, from.y, to.x, to.y)],
    );
  }

  /**
   * Fixes the wire being drawn at `at`. The next stretch starts there, unless `at` joins
   * a post or a wire, or is where this stretch started: either ends the wire.
   */
  private clickWiring(wiring: Wiring, at: Point) {
    this.routeWiring(wiring, at);

    const { preview } = wiring;
    const isDone = preview.length === 0 || this.isConnection(at);

    this.wiring = isDone
      ? null
      : {
          kind: wiring.kind,
          anchor: at,
          isHorizontalFirst: null,
          preview: [],
          isPressHeld: false,
        };

    if (preview.length > 0) {
      this.add(preview, false);
    }

    this.updateCursor();
    this.invalidate();
  }

  /** Drops the wire being drawn; what earlier clicks fixed stays. True when there was one. */
  stopWiring() {
    if (!this.wiring) {
      return false;
    }

    this.wiring = null;
    this.updateCursor();
    this.invalidate();

    return true;
  }

  private setHoveredPost(post: Point | null) {
    if (post?.x !== this.hoveredPost?.x || post?.y !== this.hoveredPost?.y) {
      this.hoveredPost = post;
      this.updateCursor();
      this.invalidate();
    }
  }

  // Editing commands

  /** Applies `edit` to the selection as one undo step; nothing happens without one. */
  /** Applies `edit` to the selection and what its groups hold, as one undo step. */
  private editSelected(edit: (elements: CircuitElement[]) => void) {
    const elements = this.affectedElements;

    if (elements.length === 0) {
      return;
    }

    this.checkpoint();
    edit(elements);
    this.commit();
  }

  deleteSelection() {
    this.editSelected((elements) => {
      const deleted = new Set(elements);

      this.circuit.elements = this.circuit.elements.filter(
        (element) => !deleted.has(element),
      );
      this.selection.clear();
    });
  }

  /** Moves the selection by whole grid steps. */
  moveSelection(stepsX: number, stepsY: number) {
    this.editSelected((elements) => {
      const wires = new AttachedWires(this.circuit.elements, new Set(elements));
      const dx = stepsX * GRID_SIZE;
      const dy = stepsY * GRID_SIZE;

      for (const element of elements) {
        element.translate(dx, dy);
      }

      this.moveAttachedWires(wires, dx, dy);
      this.removeCollapsedWires(wires);
    });
  }

  /** Moves the wires attached to the selection, adding and removing their bends. */
  private moveAttachedWires(wires: AttachedWires, dx: number, dy: number) {
    const { added, removed } = wires.moveBy(dx, dy);

    if (added.length > 0 || removed.length > 0) {
      this.circuit.elements = [
        ...this.circuit.elements.filter(
          (element) => !removed.includes(element),
        ),
        ...added,
      ];
    }
  }

  /** Deletes wires a move shrank to a point, such as one dragged onto its other end. */
  private removeCollapsedWires(wires: AttachedWires) {
    const collapsed = wires.collapsed();

    if (collapsed.length > 0) {
      this.circuit.elements = this.circuit.elements.filter(
        (element) => !collapsed.includes(element),
      );
    }
  }

  /** Turns the part being placed, or else the selection, a quarter turn. */
  rotateSelection(isClockwise: boolean) {
    this.transformSelection((elements) =>
      rotateElements(elements, isClockwise),
    );
  }

  /** Mirrors the part being placed, or else the selection. */
  flipSelection(axis: "horizontal" | "vertical") {
    this.transformSelection((elements) => flipElements(elements, axis));
  }

  /** Applies `transform` to the part being placed, or else to the selection. */
  private transformSelection(transform: (elements: CircuitElement[]) => void) {
    if (this.ghost) {
      transform([this.ghost]);
      this.moveGhost();

      return;
    }

    this.editSelected(transform);
  }

  duplicateSelection() {
    const copies = this.affectedElements.map(cloneElement);

    for (const copy of copies) {
      copy.translate(DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    }

    if (copies.length > 0) {
      this.add(copies);
    }
  }

  /** The selection in the circuit file format. */
  private selectionText() {
    return this.affectedElements.map((element) => element.dump()).join("\n");
  }

  copySelection() {
    const text = this.selectionText();

    if (text) {
      navigator.clipboard
        .writeText(text)
        .catch(() => this.callbacks.onClipboardError("Unable to copy."));
    }
  }

  /**
   * Copies the selection to the clipboard as a PNG, as Excalidraw does, for pasting into
   * documents and chats. The image is made while the clipboard waits for it, which keeps
   * Safari's permission from the click.
   */
  copySelectionAsPng() {
    const elements = this.affectedElements;
    const keys = new Set(elements.flatMap((e) => e.posts().map(pointKey)));

    const image = selectionImage(
      this.drawOptions(),
      elements,
      this.posts.filter(({ point }) => keys.has(pointKey(point))),
      (point) => this.run.voltageAt(point),
    );

    if (image) {
      navigator.clipboard
        .write([new ClipboardItem({ "image/png": image })])
        .then(() =>
          this.callbacks.onClipboardCopied("Copied to clipboard as PNG"),
        )
        .catch(() => this.callbacks.onClipboardError("Unable to copy as PNG."));
    }
  }

  /** Copies the selection, then deletes it once the clipboard holds it. */
  cutSelection() {
    const text = this.selectionText();

    if (text) {
      navigator.clipboard
        .writeText(text)
        .then(() => this.deleteSelection())
        .catch(() => this.callbacks.onClipboardError("Unable to cut."));
    }
  }

  /**
   * Reads the clipboard and pastes it, for menus and Ctrl+Alt+V. Firefox asks before a
   * page reads the clipboard outside a paste event; Ctrl+V uses that event instead.
   */
  pasteFromClipboard(isInPlace: boolean) {
    navigator.clipboard
      .readText()
      .then((text) => this.paste(text, isInPlace))
      .catch(() => this.callbacks.onClipboardError("Unable to paste."));
  }

  /**
   * Adds the elements in `text`. With `isInPlace` they keep their positions; otherwise
   * their top-left corner lands on the pointer. Returns false when `text` holds no
   * circuit lines, so other pasted text is left alone.
   */
  paste(text: string, isInPlace: boolean) {
    const elements = text.split(/\r?\n/u).flatMap((line) => {
      const element = readElementLine(line);

      return element ? [element] : [];
    });

    const corner = cornerOfElements(elements);

    if (!corner) {
      return false;
    }

    if (!isInPlace) {
      const at = snapped(this.pointer);
      const from = snapped(corner);

      for (const element of elements) {
        element.translate(at.x - from.x, at.y - from.y);
      }
    }

    this.add(elements);

    return true;
  }

  /** Swaps an element for an edited copy, keeping its identity for scopes. */
  replaceElement(original: CircuitElement, replacement: CircuitElement) {
    const index = this.circuit.elements.indexOf(original);

    if (index < 0) {
      return;
    }

    this.checkpoint();
    replacement.id = original.id;
    this.circuit.elements[index] = replacement;

    if (this.selection.delete(original)) {
      this.selection.add(replacement);
    }

    this.commit();
  }

  /** Opens the properties dialog when exactly one element is selected. */
  editSelection() {
    const [element] = this.selectedElements;

    if (element && this.selection.size === 1) {
      this.callbacks.onEditRequest(element);
    }
  }

  // Camera

  /** The schematic point under a viewport point. */
  private toWorld(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();

    return this.camera.toWorld({
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  }

  zoomTo(scale: number) {
    this.camera.zoomTo(scale);
  }

  zoomIn() {
    this.camera.zoomTo(this.camera.scale * ZOOM_STEP);
  }

  zoomOut() {
    this.camera.zoomTo(this.camera.scale / ZOOM_STEP);
  }

  zoomToDrawing() {
    this.camera.fitDrawing();
  }

  /** Brings the posts that join nothing into view and flags them for a moment. */
  showLooseEnds() {
    if (this.looseEnds.length === 0) {
      return;
    }

    this.camera.reveal(boundsOf(this.looseEnds, LOOSE_END_MARGIN));
    this.looseEndsShownAt = performance.now();
    this.isFlashingLooseEnds = true;
    this.invalidate();
  }

  zoomToSelection() {
    const box = boundsOfElements(this.selectedElements);

    if (box) {
      this.camera.fit(box);
    }
  }

  scrollBy(dx: number, dy: number) {
    this.camera.scrollBy(dx, dy);
  }

  // Pointer

  /**
   * The element nearest `point` within the pick distance; null when there is none. As in
   * Multisim, wires lie on top of parts: a wire that close wins even over a part the
   * pointer is inside.
   */
  private elementAt(point: Point) {
    let best: CircuitElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const element of this.circuit.elements) {
      const distance = distanceToElement(element, point);

      if (distance > PICK_DISTANCE) {
        continue;
      }

      const score = element.isStretchable()
        ? distance
        : distance + WIRE_PREFERENCE;

      // Later elements draw on top, so they win ties.
      if (score <= bestScore) {
        best = element;
        bestScore = score;
      }
    }

    return best;
  }

  /** The element whose label is under `point`, topmost first; null when labels are hidden. */
  private labelAt(point: Point) {
    if (!this.display.showValues) {
      return null;
    }

    for (const element of [...this.circuit.elements].reverse()) {
      const box = this.painter.labelBoxes.get(element.id);

      if (box && isOnLabel(point, box)) {
        return element;
      }
    }

    return null;
  }

  /** The selected wire's end under `point`, for dragging it; parts keep their size. */
  private endAt(point: Point) {
    const [element] = this.selection.size === 1 ? this.selection : [];

    if (!element?.isStretchable() && !element?.isEnclosure()) {
      return null;
    }

    for (const isStart of [true, false]) {
      const end = isStart ? element.start : element.end;

      if (Math.hypot(end.x - point.x, end.y - point.y) <= PICK_DISTANCE) {
        return { element, isStart };
      }
    }

    return null;
  }

  private handlePointerDown(event: PointerEvent) {
    const point = this.toWorld(event.clientX, event.clientY);

    this.pointer = point;
    this.canvas.focus();

    // The middle button, or the left one with Space held, pans.
    if (event.button === 1 || (event.button === 0 && this.isSpaceHeld)) {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: "pan",
        start: { x: event.clientX, y: event.clientY },
        scrolled: { x: 0, y: 0 },
      };
      this.updateCursor();

      return;
    }

    if (event.button !== 0) {
      return;
    }

    this.canvas.setPointerCapture(event.pointerId);
    this.drag = this.startDrag(point, event.shiftKey);
    this.invalidate();
  }

  /** The gesture a left press at `point` begins, or null when the press finishes it. */
  private startDrag(point: Point, isShift: boolean): Drag | null {
    // While a wire is being drawn, every click fixes its next stretch.
    if (this.wiring) {
      this.clickWiring(this.wiring, snapped(point));

      return null;
    }

    if (this.ghost) {
      this.placeGhost(this.ghost);

      return null;
    }

    // A tool for a part that stretches starts drawing one.
    if (this.tool.kind) {
      this.startWiring(snapped(point), this.tool.kind);

      return null;
    }

    // A press on the selected wire's end drags that end.
    const end = this.endAt(point);

    if (end) {
      return {
        kind: "end",
        before: snapshotOf(this.circuit.elements),
        ...end,
        hasMoved: false,
      };
    }

    // A press on a net's tag drags it; its wire keeps where it went.
    const tag = isShift ? null : this.netTagAt(point);

    if (tag) {
      return {
        kind: "label",
        before: snapshotOf(this.circuit.elements),
        element: tag.wire,
        origin: point,
        startOffset: tag.offset,
        hasMoved: false,
      };
    }

    // A press on a part's label selects the part and drags the label; a group's title
    // is a handle for the group instead, as Excalidraw's frame names are.
    const labelOwner = isShift ? null : this.labelAt(point);
    const titled = labelOwner?.isEnclosure() ? labelOwner : null;

    if (labelOwner && !titled) {
      if (!this.selection.has(labelOwner) || this.selection.size !== 1) {
        this.select([labelOwner]);
      }

      return {
        kind: "label",
        before: snapshotOf(this.circuit.elements),
        element: labelOwner,
        origin: point,
        startOffset: labelOwner.labelOffset,
        hasMoved: false,
      };
    }

    // A press on a post starts a wire from it.
    const post = isShift ? null : this.postAt(point);

    if (post) {
      this.select([]);
      this.startWiring(post, WIRE_KIND);

      return null;
    }

    // A press on empty canvas starts a rubber band; Shift adds to the selection.
    const element = titled ?? this.elementAt(point);

    if (!element) {
      if (!isShift) {
        this.select([]);
      }

      return {
        kind: "band",
        origin: point,
        current: point,
        isAdditive: isShift,
      };
    }

    // A push switch stays pressed until the release.
    if (element.isPushButton()) {
      this.run.press(element, true);

      return { kind: "press", element };
    }

    // Shift toggles the element in the selection; without Shift, an unselected
    // element becomes the selection. Then a drag moves the selection.
    if (isShift) {
      if (!this.selection.delete(element)) {
        this.selection.add(element);
      }

      this.emitSelection();
    } else if (!this.selection.has(element)) {
      this.select([element]);
    }

    const moved = new Set(this.affectedElements);

    return {
      kind: "move",
      before: snapshotOf(this.circuit.elements),
      origin: snapped(point),
      applied: snapped(point),
      moved,
      wires: new AttachedWires(this.circuit.elements, moved),
      hasMoved: false,
      clicked: element,
    };
  }

  private handlePointerMove(event: PointerEvent) {
    const point = this.toWorld(event.clientX, event.clientY);
    const { drag } = this;

    this.pointer = point;
    this.isPointerInside = true;

    const at = snapped(point);

    if (this.wiring) {
      this.routeWiring(this.wiring, at);
      this.invalidate();

      return;
    }

    if (!drag) {
      const isSelecting = !this.tool.kind && !this.isSpaceHeld;

      this.moveGhost();
      const labelOwner = this.tool.kind ? null : this.labelAt(point);

      const isOverLabel =
        labelOwner !== null ||
        (!this.tool.kind && this.netTagAt(point) !== null);

      if (this.isOverLabel !== isOverLabel) {
        this.isOverLabel = isOverLabel;
        this.updateCursor();
      }

      this.setHovered(
        this.tool.kind ? null : (labelOwner ?? this.elementAt(point)),
      );
      this.setHoveredPost(
        isSelecting && !this.endAt(point) ? this.postAt(point) : null,
      );

      return;
    }

    switch (drag.kind) {
      case "pan": {
        const dx = event.clientX - drag.start.x;
        const dy = event.clientY - drag.start.y;

        this.camera.scrollBy(drag.scrolled.x - dx, drag.scrolled.y - dy);
        drag.scrolled = { x: dx, y: dy };
        break;
      }
      case "move": {
        const dx = at.x - drag.applied.x;
        const dy = at.y - drag.applied.y;

        if (dx !== 0 || dy !== 0) {
          for (const element of drag.moved) {
            element.translate(dx, dy);
          }

          this.moveAttachedWires(
            drag.wires,
            at.x - drag.origin.x,
            at.y - drag.origin.y,
          );
          drag.applied = at;
          drag.hasMoved = true;
          this.countPosts();
        }

        break;
      }
      case "end": {
        const { element, isStart } = drag;

        if (isStart) {
          element.x1 = at.x;
          element.y1 = at.y;
        } else {
          element.x2 = at.x;
          element.y2 = at.y;
        }

        drag.hasMoved = true;
        this.countPosts();
        break;
      }
      case "label": {
        // Labels move freely, by whole schematic units, not by grid steps.
        drag.element.labelOffset = {
          x: drag.startOffset.x + Math.round(point.x - drag.origin.x),
          y: drag.startOffset.y + Math.round(point.y - drag.origin.y),
        };
        drag.hasMoved = true;
        break;
      }
      case "band":
        drag.current = point;
        break;
      case "press":
        break;
    }

    this.invalidate();
  }

  private handlePointerUp(event: PointerEvent) {
    const { drag } = this;

    this.drag = null;

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    this.releaseWiring(this.toWorld(event.clientX, event.clientY));

    switch (drag?.kind) {
      case "pan":
        this.updateCursor();
        break;
      case "move":
      case "end":
      case "label":
        // A drag commits the move; a click without a drag toggles a switch.
        if (drag.hasMoved) {
          if (drag.kind === "move") {
            this.removeCollapsedWires(drag.wires);
          }

          this.history.record(drag.before);
          this.commit();
        } else if (
          drag.kind === "move" &&
          drag.clicked.isToggle() &&
          !event.shiftKey
        ) {
          this.checkpoint();
          drag.clicked.toggle();
          this.commit();
        }

        break;
      case "band": {
        const box = boxBetween(drag.origin, drag.current);

        const inside = this.circuit.elements.filter((element) =>
          isInside(element, box),
        );

        this.select(drag.isAdditive ? [...this.selection, ...inside] : inside);
        break;
      }
      case "press":
        this.run.press(drag.element, false);
        break;
      case undefined:
        break;
    }

    this.invalidate();
  }

  /**
   * Ends the press that started a wire. A press dragged away from where it began draws
   * one wire to the release point, as before; a plain click leaves the wire following
   * the pointer.
   */
  private releaseWiring(point: Point) {
    const { wiring } = this;

    if (!wiring?.isPressHeld) {
      return;
    }

    const at = snapped(point);

    wiring.isPressHeld = false;

    if (at.x !== wiring.anchor.x || at.y !== wiring.anchor.y) {
      this.clickWiring(wiring, at);
      this.stopWiring();
    }
  }

  private handleWheel(event: WheelEvent) {
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();

    // As in Inkscape: Ctrl zooms about the pointer, Shift scrolls sideways, and
    // the plain wheel scrolls down.
    if (event.ctrlKey || event.metaKey) {
      this.camera.zoomTo(
        this.camera.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      );
    } else if (event.shiftKey) {
      this.scrollBy(event.deltaY + event.deltaX, 0);
    } else {
      this.scrollBy(event.deltaX, event.deltaY);
    }
  }

  private setHovered(element: CircuitElement | null) {
    if (element !== this.hovered) {
      this.hovered = element;
      this.emitInfo(true);
      this.invalidate();
    }
  }

  /** Reports the readout of the hovered element, or else the only selected one. */
  private emitInfo(isImmediate: boolean) {
    const now = performance.now();

    if (!isImmediate && now - this.lastInfoTime < INFO_INTERVAL_MS) {
      return;
    }

    this.lastInfoTime = now;

    const [selected] = this.selection.size === 1 ? this.selection : [];
    const element = this.hovered ?? selected;

    if (!element) {
      this.callbacks.onInfo(null);

      return;
    }

    const net = this.netOf(element);

    // Wires and labels name their net, to match it with analysis results.
    this.callbacks.onInfo(
      net === null
        ? element.info()
        : [
            ...element.info(),
            `Net ${net === 0 ? "0 (ground)" : this.run.netName(net)}`,
          ],
    );
  }

  /** The node a wire or net label sits on; null for every other element. */
  private netOf(element: CircuitElement | null) {
    return element?.isNetElement() ? element.node(0) : null;
  }

  // Keyboard

  /** Releases Space, which turns dragging into panning while held, as in Inkscape. */
  handleKeyUp(event: KeyboardEvent) {
    if (event.key === " ") {
      this.isSpaceHeld = false;
      this.updateCursor();
    }
  }

  /** Runs the canvas command or tool for a key press; returns true when it used it. */
  handleKeyDown(event: KeyboardEvent) {
    if (event.key === " " && !event.ctrlKey && !event.metaKey) {
      this.isSpaceHeld = true;
      this.updateCursor();

      return true;
    }

    const command = commandForKey(event);

    if (command?.run) {
      command.run(this, event);

      return true;
    }

    const tool = toolForKey(event);

    if (tool) {
      this.setTool(tool.id);
    }

    return tool !== undefined;
  }

  // Drawing

  /** How many posts meet at each point, for junction dots. */
  private countPosts() {
    const counts = new Map<string, PostPoint>();

    for (const element of this.circuit.elements) {
      for (const point of element.posts()) {
        const key = pointKey(point);

        counts.set(key, { point, count: (counts.get(key)?.count ?? 0) + 1 });
      }
    }

    this.posts = [...counts.values()];

    // A post on a wire's middle joins it once the edit is finished.
    const looseEnds = this.posts.flatMap(({ point, count }) =>
      count === 1 && !isOnWire(this.circuit.elements, point) ? [point] : [],
    );

    if (looseEnds.length !== this.looseEnds.length) {
      this.callbacks.onLooseEndsChange(looseEnds.length);
    }

    this.looseEnds = looseEnds;

    this.invalidate();
  }

  /** Where a click would join the wire being drawn, or start one; null for nowhere. */
  private snapPoint() {
    if (!this.wiring) {
      return this.hoveredPost;
    }

    const at = snapped(this.pointer);

    return this.isConnection(at) ? at : null;
  }

  /**
   * Tags each net at its busiest junction with its name, when net names show, and its
   * operating-point voltage, once there is one. Ground goes untagged, and a net label
   * already shows its net's name.
   */
  private netTags() {
    const { netVoltages } = this;
    const { showNetNames } = this.display;
    const anchors = new Map<string, { post: PostPoint; isLabeled: boolean }>();

    if (!netVoltages && !showNetNames) {
      return [];
    }

    for (const post of this.posts) {
      const net = this.run.netAt(post.point);

      if (!net || net.name === "0") {
        continue;
      }

      const best = anchors.get(net.name);

      if (!best || post.count > best.post.count) {
        anchors.set(net.name, { post, isLabeled: net.isLabeled });
      }
    }

    const wires = this.wiresByNet();

    return [...anchors].flatMap(([net, { post, isLabeled }]) => {
      const voltage = netVoltages?.get(net) ?? null;
      const isNamed = showNetNames && !isLabeled;

      if (!isNamed && voltage === null) {
        return [];
      }

      // A moved tag sits where its wire's label offset puts it.
      const holder = tagHolder(wires.get(net) ?? []);

      const point = holder
        ? {
            x: holder.start.x + holder.labelOffset.x,
            y: holder.start.y + holder.labelOffset.y,
          }
        : post.point;

      return [
        {
          net,
          point,
          anchor: post.point,
          name: isNamed ? net : null,
          voltage,
        },
      ];
    });
  }

  /** The wires on each net, by the name results use. */
  private wiresByNet() {
    const wires = new Map<string, CircuitElement[]>();

    for (const element of this.circuit.elements) {
      const net = isWire(element) ? this.run.netAt(element.start) : null;

      if (net) {
        wires.set(net.name, [...(wires.get(net.name) ?? []), element]);
      }
    }

    return wires;
  }

  /**
   * The net tag under `point`, as the wire that keeps its place and that wire's label
   * offset. An unmoved tag goes to a wire at its junction, or else any on its net; a
   * net without wires has no tag to move.
   */
  private netTagAt(point: Point) {
    const net = [...this.painter.netTagBoxes].findLast(([, box]) =>
      isOnLabel(point, box),
    )?.[0];

    const tag = this.netTags().find((candidate) => candidate.net === net);

    if (!tag) {
      return null;
    }

    const wires = this.wiresByNet().get(tag.net) ?? [];
    const holder = tagHolder(wires);

    if (holder) {
      return { wire: holder, offset: holder.labelOffset };
    }

    const { anchor } = tag;

    const wire =
      wires.find((candidate) =>
        [candidate.start, candidate.end].some(
          ({ x, y }) => x === anchor.x && y === anchor.y,
        ),
      ) ?? wires[0];

    if (!wire) {
      return null;
    }

    return {
      wire,
      offset: { x: anchor.x - wire.start.x, y: anchor.y - wire.start.y },
    };
  }

  /** Steps the interactive simulation every animation frame and redraws when needed. */
  private tick = (now: number) => {
    const elapsed =
      this.lastFrameTime === 0 ? FIRST_FRAME_MS : now - this.lastFrameTime;

    this.lastFrameTime = now;

    if (this.hasWiperMoved) {
      this.hasWiperMoved = false;
      this.run.rebuild(this.circuit);
      this.callbacks.onChange(this.circuit.dump());
    }

    if (this.run.runFrame(elapsed, this.display.showCurrentDots)) {
      this.emitInfo(false);
      this.invalidate();
    }

    // Redraws each frame of the flash, and once more after it to clear it.
    if (this.isFlashingLooseEnds) {
      this.isFlashingLooseEnds = this.looseEndFlash(now) !== null;
      this.invalidate();
    }

    if (this.isDirty) {
      this.isDirty = false;
      this.render(now);
    }

    this.frame = requestAnimationFrame(this.tick);
  };

  /** How far through flagging the loose ends the canvas is at `now`, 0 to 1; null when done. */
  private looseEndFlash(now: number) {
    const progress = (now - this.looseEndsShownAt) / LOOSE_END_FLASH_MS;

    // A frame's time can fall just before the click that started the flash.
    return progress < 1 ? Math.max(progress, 0) : null;
  }

  /** Draws the schematic with the gesture, ghost, hovered net and voltage tags. */
  private render(now: number) {
    const { drag } = this;
    const hoveredNet = drag ? null : this.netOf(this.hovered);
    const flash = this.looseEndFlash(now);

    renderScene(this.painter, this.camera, window.devicePixelRatio || 1, {
      elements: this.circuit.elements,
      selection: this.selection,
      faults: this.run.faults,
      placing: this.wiring?.preview ?? [],
      snapPoint: this.isPointerInside && !drag ? this.snapPoint() : null,
      ghost: this.isPointerInside && !drag ? this.ghost : null,
      band:
        drag?.kind === "band" ? boxBetween(drag.origin, drag.current) : null,
      posts: this.posts,
      looseEndFlash:
        flash === null
          ? null
          : {
              points: this.looseEnds,
              progress: flash,
              isMoving: !window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches,
            },
      hoveredNet:
        hoveredNet === null
          ? []
          : this.circuit.elements.filter(
              (element) => this.netOf(element) === hoveredNet,
            ),
      netTags: this.netTags(),
      showGrid: this.display.showGrid,
      gridStyle: this.display.gridStyle,
      voltageAt: (point) => this.run.voltageAt(point),
      dotOffsetsOf: (element) => this.run.dotOffsetsOf(element),
    });
  }
}
