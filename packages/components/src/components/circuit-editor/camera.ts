import type { Point } from "@lunar-spice/simulator/geometry";
import type { Bounds } from "@lunar-spice/simulator/layout";

/** Canvas edges covered by floating controls, in CSS pixels. */
export type Insets = {
  top: number;
  bottom: number;
  right: number;
};

const MIN_SCALE = 0.25;

const MAX_SCALE = 8;

/** Fitting never magnifies past this, so a small circuit stays readable. */
const MAX_FIT_SCALE = 2;

/** Space kept between a fitted drawing and the canvas edges or floating controls. */
const FIT_GUTTER = 32;

/**
 * Where the schematic sits on the canvas: a scale and the canvas position of the
 * schematic origin. Points in, such as pointer positions, are in canvas CSS pixels.
 */
export class Camera {
  private x = 0;
  private y = 0;
  private scaleValue = 1;
  private size = { width: 0, height: 0 };
  private insets: Insets = { top: 0, bottom: 0, right: 0 };
  /** True while it shows the whole drawing; resizes then fit it again. */
  private isFittedToDrawing = false;
  private readonly onViewChange: (scale: number) => void;
  private readonly drawingBounds: () => Bounds | null;

  /** `onViewChange` hears every move, resize and zoom, with the scale after it. */
  constructor(
    onViewChange: (scale: number) => void,
    drawingBounds: () => Bounds | null,
  ) {
    this.onViewChange = onViewChange;
    this.drawingBounds = drawingBounds;
  }

  get scale() {
    return this.scaleValue;
  }

  /** The schematic point under a canvas point. */
  toWorld({ x, y }: Point): Point {
    return {
      x: (x - this.x) / this.scaleValue,
      y: (y - this.y) / this.scaleValue,
    };
  }

  /** Sets `context` to draw schematic units at device pixel `ratio`. */
  apply(context: CanvasRenderingContext2D, ratio: number) {
    context.setTransform(
      ratio * this.scaleValue,
      0,
      0,
      ratio * this.scaleValue,
      ratio * this.x,
      ratio * this.y,
    );
  }

  /** The canvas position of the schematic origin, for the grid's phase. */
  get origin(): Point {
    return { x: this.x, y: this.y };
  }

  /**
   * Matches a new canvas size, as when the results panel opens. A fitted drawing is
   * fitted again; otherwise the middle of the view stays put.
   */
  resize(width: number, height: number) {
    const previous = this.size;

    this.size = { width, height };

    if (this.isFittedToDrawing) {
      this.fitDrawing();
    } else if (previous.width > 0) {
      this.x += (width - previous.width) / 2;
      this.y += (height - previous.height) / 2;
      this.onViewChange(this.scaleValue);
    }
  }

  /** Keeps fitted drawings clear of the floating controls, which React measures. */
  setInsets(insets: Insets) {
    this.insets = insets;

    if (this.isFittedToDrawing) {
      this.fitDrawing();
    }
  }

  /** Zooms to `scale`, keeping the canvas point `anchor` still (its middle by default). */
  zoomTo(scale: number, anchor?: Point) {
    const at = anchor ?? { x: this.size.width / 2, y: this.size.height / 2 };
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const world = this.toWorld(at);

    this.x = at.x - world.x * next;
    this.y = at.y - world.y * next;
    this.setScale(next);
    this.isFittedToDrawing = false;
  }

  /** Shows the whole drawing, and keeps showing it as the canvas resizes. */
  fitDrawing() {
    this.fit(this.drawingBounds());
    this.isFittedToDrawing = true;
  }

  /** Fits `box` between the floating controls; with no box, centers the origin at 1:1. */
  fit(box: Bounds | null) {
    const { width, height } = this.size;

    this.isFittedToDrawing = false;

    if (!box || width === 0) {
      this.x = width / 2;
      this.y = height / 2;
      this.setScale(1);

      return;
    }

    const top = this.insets.top + FIT_GUTTER;
    const bottom = this.insets.bottom + FIT_GUTTER;
    const roomHeight = height - top - bottom;
    const roomWidth = width - this.insets.right - 2 * FIT_GUTTER;

    const scale = Math.min(
      MAX_FIT_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min(
          roomWidth / Math.max(box.right - box.left, 1),
          roomHeight / Math.max(box.bottom - box.top, 1),
        ),
      ),
    );

    this.x = FIT_GUTTER + roomWidth / 2 - ((box.left + box.right) / 2) * scale;
    this.y = top + roomHeight / 2 - ((box.top + box.bottom) / 2) * scale;
    this.setScale(scale);
  }

  /** Moves the view by canvas pixels. */
  scrollBy(dx: number, dy: number) {
    this.x -= dx;
    this.y -= dy;
    this.isFittedToDrawing = false;
    this.onViewChange(this.scaleValue);
  }

  private setScale(scale: number) {
    this.scaleValue = scale;
    this.onViewChange(scale);
  }
}
