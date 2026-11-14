import type { CircuitElement } from "@lunar-spice/simulator/element";
import type { Point } from "@lunar-spice/simulator/geometry";
import { type Bounds, boundsOfElements } from "@lunar-spice/simulator/layout";

import { type DrawOptions, SchematicPainter } from "./draw-elements";
import type { PostPoint } from "./render-scene";

/** Schematic units of background around the drawing, as Excalidraw pads its PNGs. */
const IMAGE_PADDING = 16;

/** Image pixels per schematic unit, so the image stays sharp on high-density screens. */
const IMAGE_SCALE = 2;

/** The longest side an image may have, in pixels; browsers refuse larger canvases. */
const MAX_IMAGE_SIDE = 8192;

/** A 2D context on a new canvas; throws where the browser has none. */
function newContext() {
  const context = document.createElement("canvas").getContext("2d");

  if (!context) {
    throw new Error("Canvas drawing is not available.");
  }

  return context;
}

/** Draws the elements, then the posts among them, in schematic units. */
function drawParts(
  painter: SchematicPainter,
  elements: readonly CircuitElement[],
  posts: readonly PostPoint[],
  voltageAt: (point: Point) => number,
) {
  for (const element of elements) {
    painter.draw(element, { accent: null, dotOffsets: [] });
  }

  for (const { point, count } of posts) {
    painter.post(point, voltageAt(point), count);
  }
}

/** The box around the elements' drawings and their labels, measured off screen. */
function drawingBounds(
  options: DrawOptions,
  elements: readonly CircuitElement[],
): Bounds | null {
  const body = boundsOfElements(elements);

  if (!body) {
    return null;
  }

  // Labels are only measured as they are drawn.
  const painter = new SchematicPainter(newContext(), options);

  drawParts(painter, elements, [], () => 0);

  return [...painter.labelBoxes.values()].reduce(
    (box, label) => ({
      left: Math.min(box.left, label.left),
      top: Math.min(box.top, label.top),
      right: Math.max(box.right, label.right),
      bottom: Math.max(box.bottom, label.bottom),
    }),
    body,
  );
}

/**
 * Draws `elements` as a PNG for the clipboard, the way Excalidraw copies a selection: on
 * the canvas background with a margin, in their voltage colors, without the grid, the
 * selection color or the moving current dots. `posts` are the junctions and loose ends
 * among them. Null when there is nothing to draw.
 */
export function selectionImage(
  options: DrawOptions,
  elements: readonly CircuitElement[],
  posts: readonly PostPoint[],
  voltageAt: (point: Point) => number,
): Promise<Blob> | null {
  const imageOptions = { ...options, showCurrentDots: false };
  const box = drawingBounds(imageOptions, elements);

  if (!box) {
    return null;
  }

  const width = box.right - box.left + 2 * IMAGE_PADDING;
  const height = box.bottom - box.top + 2 * IMAGE_PADDING;
  const scale = Math.min(IMAGE_SCALE, MAX_IMAGE_SIDE / Math.max(width, height));
  const context = newContext();
  const { canvas } = context;

  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  context.fillStyle = options.palette.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(
    scale,
    0,
    0,
    scale,
    (IMAGE_PADDING - box.left) * scale,
    (IMAGE_PADDING - box.top) * scale,
  );

  drawParts(
    new SchematicPainter(context, imageOptions),
    elements,
    posts,
    voltageAt,
  );

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) =>
      blob ? resolve(blob) : reject(new Error("The image could not be made.")),
    ),
  );
}
