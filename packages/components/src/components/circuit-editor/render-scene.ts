import type { CircuitElement } from "@lunar-spice/simulator/element";
import { GRID_SIZE, type Point } from "@lunar-spice/simulator/geometry";
import type { Bounds } from "@lunar-spice/simulator/layout";
import { formatSi } from "@lunar-spice/simulator/units";

import type { Camera } from "./camera";
import type { SchematicPainter } from "./draw-elements";

/** How many posts meet at one point, for junction dots. */
export type PostPoint = {
  point: Point;
  count: number;
};

/** Everything one frame of the schematic shows. */
export type Scene = {
  elements: readonly CircuitElement[];
  selection: ReadonlySet<CircuitElement>;
  /** Parts behind a simulation error. */
  faults: ReadonlySet<CircuitElement>;
  /** The stretch of wire being drawn, not yet in the circuit. */
  placing: readonly CircuitElement[];
  /** Where a click would join or start a wire, ringed. */
  snapPoint: Point | null;
  /** The part a placing tool shows under the pointer, drawn faintly. */
  ghost: CircuitElement | null;
  /** The rubber band being dragged. */
  band: Bounds | null;
  posts: readonly PostPoint[];
  /** The elements of the net under the pointer, banded underneath. */
  hoveredNet: readonly CircuitElement[];
  /** Operating-point voltage tags, each at its net's busiest junction. */
  voltageTags: readonly { point: Point; voltage: number }[];
  showGrid: boolean;
  voltageAt: (point: Point) => number;
  dotOffsetsOf: (element: CircuitElement) => readonly number[];
};

/** Grid dots this close together are thinned out, in CSS pixels. */
const MIN_GRID_SPACING = 12;

/** Opacity of the part a placing tool shows under the pointer. */
const GHOST_ALPHA = 0.5;

/** Opacity of the rubber band's fill. */
const BAND_FILL_ALPHA = 0.08;

/** Draws `scene` onto the painter's canvas through `camera`, at device pixel `ratio`. */
export function renderScene(
  painter: SchematicPainter,
  camera: Camera,
  ratio: number,
  scene: Scene,
) {
  const { context, palette } = painter;
  const { canvas } = context;

  // Background and grid, in device pixels
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (scene.showGrid) {
    renderGrid(context, camera, ratio, palette.border);
  }

  // Schematic, in schematic units
  camera.apply(context, ratio);

  for (const element of scene.hoveredNet) {
    painter.netBand(element.start, element.end);
  }

  for (const element of [...scene.elements, ...scene.placing]) {
    const isSelected =
      scene.selection.has(element) || scene.placing.includes(element);

    painter.draw(element, {
      accent: isSelected
        ? palette.primary
        : scene.faults.has(element)
          ? palette.destructive
          : null,
      dotOffsets: scene.dotOffsetsOf(element),
    });
  }

  for (const { point, count } of scene.posts) {
    painter.post(point, scene.voltageAt(point), count);
  }

  for (const { point, voltage } of scene.voltageTags) {
    painter.voltageTag(point, formatSi(voltage, "V", 3));
  }

  // Overlays: stretch handles, ghost and rubber band
  const [selected] = scene.selection.size === 1 ? scene.selection : [];

  // A part that stretches can be dragged by its ends.
  if (selected?.isStretchable()) {
    painter.handle(selected.start);
    painter.handle(selected.end);
  }

  if (scene.snapPoint) {
    painter.snapRing(scene.snapPoint);
  }

  if (scene.ghost) {
    context.globalAlpha = GHOST_ALPHA;
    painter.draw(scene.ghost, { accent: palette.primary, dotOffsets: [] });
    context.globalAlpha = 1;
  }

  if (scene.band) {
    const { left, top, right, bottom } = scene.band;

    context.fillStyle = palette.primary;
    context.globalAlpha = BAND_FILL_ALPHA;
    context.fillRect(left, top, right - left, bottom - top);
    context.globalAlpha = 1;
    context.strokeStyle = palette.primary;
    context.lineWidth = 1 / camera.scale;
    context.strokeRect(left, top, right - left, bottom - top);
  }
}

/** Draws a dot at each grid point; doubles the spacing when the dots are too close. */
function renderGrid(
  context: CanvasRenderingContext2D,
  camera: Camera,
  ratio: number,
  color: string,
) {
  const { canvas } = context;
  const { origin, scale } = camera;
  let spacing = GRID_SIZE * scale;

  while (spacing < MIN_GRID_SPACING) {
    spacing *= 2;
  }

  const startX = ((origin.x % spacing) + spacing) % spacing;
  const startY = ((origin.y % spacing) + spacing) % spacing;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  const size = Math.max(1, scale) * ratio;

  context.fillStyle = color;

  for (let x = startX; x < width; x += spacing) {
    for (let y = startY; y < height; y += spacing) {
      context.fillRect(x * ratio - size / 2, y * ratio - size / 2, size, size);
    }
  }
}
