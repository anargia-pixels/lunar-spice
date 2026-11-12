import type {
  CircuitElement,
  ElementKind,
} from "@lunar-spice/simulator/element";
import {
  NetLabel,
  SpdtSwitch,
  Switch,
  THROW_OFFSET,
} from "@lunar-spice/simulator/elements/connectors";
import {
  TIMER_PINS,
  TIMER_SIZE,
  LinearRegulator,
} from "@lunar-spice/simulator/elements/integrated-circuits";
import { OpAmp } from "@lunar-spice/simulator/elements/op-amp";
import {
  Potentiometer,
  VariableResistor,
} from "@lunar-spice/simulator/elements/passive";
import { SchmittTrigger } from "@lunar-spice/simulator/elements/schmitt-trigger";
import {
  Bjt,
  Diode,
  Led,
  Jfet,
  Mosfet,
} from "@lunar-spice/simulator/elements/semiconductors";
import { VoltageSource } from "@lunar-spice/simulator/elements/sources";
import {
  distance,
  interpolate,
  type Point,
} from "@lunar-spice/simulator/geometry";
import type { Bounds } from "@lunar-spice/simulator/layout";

import { type CanvasPalette, mixRgb, rgbText } from "../../lib/canvas-palette";
import { DOT_SPACING } from "./current-dots";
import type { DisplayOptions } from "./display-options";

/**
 * How the schematic is drawn: the appearance settings, the theme's palette and the
 * circuit's voltage range.
 */
export type DrawOptions = Omit<DisplayOptions, "showGrid"> & {
  palette: CanvasPalette;
  /** Voltage drawn at full color. */
  voltageRange: number;
};

/** One element's drawing state. */
export type ElementLook = {
  /** One color for the whole element, as when selected; null draws its voltages. */
  accent: string | null;
  /** Where the current dots start on each of the element's paths, in schematic units. */
  dotOffsets: readonly number[];
};

const LINE_WIDTH = 2;

const LABEL_SIZE = 11;

/** Radius of the bubble at an inverting Schmitt trigger's output. */
const SCHMITT_BUBBLE_RADIUS = 3;

/** An element's designator and value, whichever it has, for labels beside it. */
function labelLines(element: CircuitElement) {
  return [element.designator, element.valueLabel()].filter(Boolean);
}

/** Draws elements in schematic units onto a context already scaled to the camera. */
export class SchematicPainter {
  readonly context: CanvasRenderingContext2D;
  private options: DrawOptions;
  private look: ElementLook = { accent: null, dotOffsets: [] };
  /** How each kind of element is drawn; every kind must have one. */
  private readonly drawers: Record<
    ElementKind,
    (element: CircuitElement) => void
  > = {
    wire: (element) => this.drawWire(element),
    ground: (element) => this.drawGround(element),
    label: (element) => this.drawLabel(element),
    probe: (element) => this.drawProbe(element),
    resistor: (element) => this.drawResistor(element),
    potentiometer: (element) => this.drawPotentiometer(element),
    "variable-resistor": (element) => this.drawVariableResistor(element),
    capacitor: (element) => this.drawCapacitor(element),
    inductor: (element) => this.drawInductor(element),
    "voltage-source": (element) => this.drawVoltageSource(element),
    rail: (element) => this.drawRail(element),
    "current-source": (element) => this.drawCurrentSource(element),
    switch: (element) => this.drawSwitch(element),
    "spdt-switch": (element) => this.drawSpdtSwitch(element),
    microphone: (element) => this.drawMicrophone(element),
    speaker: (element) => this.drawSpeaker(element),
    diode: (element) => this.drawDiode(element),
    led: (element) => this.drawDiode(element),
    bjt: (element) => this.drawBjt(element),
    mosfet: (element) => this.drawMosfet(element),
    jfet: (element) => this.drawJfet(element),
    "op-amp": (element) => this.drawOpAmp(element),
    "schmitt-trigger": (element) => this.drawSchmittTrigger(element),
    regulator: (element) => this.drawRegulator(element),
    "adjustable-regulator": (element) => this.drawRegulator(element),
    timer: (element) => this.drawTimer(element),
  };
  /** The current along each path of the element being drawn. */
  private pathCurrents: readonly number[] = [];
  /**
   * Where each element's designator and value were last drawn, by element id, so a press
   * on one can drag it. Elements without a label have none.
   */
  readonly labelBoxes = new Map<number, Bounds>();

  constructor(context: CanvasRenderingContext2D, options: DrawOptions) {
    this.context = context;
    this.options = options;
  }

  setOptions(options: DrawOptions) {
    this.options = options;
  }

  get palette() {
    return this.options.palette;
  }

  /** The font schematic text uses, as the display options pick it. */
  get fontFamily() {
    return this.options.schematicFont === "mono"
      ? this.palette.schematicMonoFamily
      : this.palette.fontFamily;
  }

  // Colors and primitives

  /** The color for `voltage`: neutral at 0, shading to positive or negative. */
  voltageColor(voltage: number) {
    const { palette, showVoltageColors, voltageRange } = this.options;

    if (this.look.accent) {
      return this.look.accent;
    }

    if (!showVoltageColors || !Number.isFinite(voltage)) {
      return rgbText(palette.foreground);
    }

    const amount = Math.max(-1, Math.min(1, voltage / voltageRange));

    return rgbText(
      amount >= 0
        ? mixRgb(palette.muted, palette.positive, amount)
        : mixRgb(palette.muted, palette.negative, -amount),
    );
  }

  /** The color of body outlines that carry no single voltage, such as an IC's box. */
  private outlineColor() {
    return this.look.accent ?? rgbText(this.palette.foreground);
  }

  private line(a: Point, b: Point, color: string) {
    const { context } = this;

    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }

  /** A polyline whose color shades from `startVoltage` to `endVoltage` along it. */
  private shadedPath(
    points: readonly Point[],
    startVoltage: number,
    endVoltage: number,
  ) {
    const last = points.length - 1;

    for (let index = 0; index < last; index += 1) {
      const a = points[index];
      const b = points[index + 1];

      if (!a || !b) {
        continue;
      }

      const voltage =
        startVoltage + ((endVoltage - startVoltage) * (index + 0.5)) / last;

      this.line(a, b, this.voltageColor(voltage));
    }
  }

  /**
   * The moving dots along `points` for path `path` of the element: its current from
   * `currentPaths()`, starting where `dotOffsets` says.
   */
  private dots(points: readonly Point[], path: number) {
    const current = this.pathCurrents[path] ?? 0;
    const offset = this.look.dotOffsets[path] ?? 0;

    if (!this.options.showCurrentDots || Math.abs(current) < 1e-9) {
      return;
    }

    const { context } = this;
    let travelled = 0;
    const start = ((offset % DOT_SPACING) + DOT_SPACING) % DOT_SPACING;

    context.fillStyle = this.palette.currentDot;

    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];

      if (!a || !b) {
        continue;
      }

      const length = distance(a, b);
      let along = start - (travelled % DOT_SPACING);

      while (along < 0) {
        along += DOT_SPACING;
      }

      for (; along < length; along += DOT_SPACING) {
        const point = interpolate(a, b, along / length);

        context.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
      }

      travelled += length;
    }
  }

  /** Writes `content` centered on `at` in the accent or foreground color. */
  private text(
    content: string,
    at: Point,
    align: CanvasTextAlign = "center",
    size = LABEL_SIZE,
  ) {
    const { context } = this;

    context.fillStyle = this.look.accent ?? rgbText(this.palette.foreground);
    context.font = `${size}px ${this.fontFamily}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.fillText(content, at.x, at.y);
  }

  /**
   * Writes one line of `element`'s label at `at`, moved by its label offset, and adds
   * where it landed to the element's label box.
   */
  private partLabel(
    element: CircuitElement,
    content: string,
    at: Point,
    align: CanvasTextAlign = "center",
    size = LABEL_SIZE,
  ) {
    const placed = {
      x: at.x + element.labelOffset.x,
      y: at.y + element.labelOffset.y,
    };

    this.text(content, placed, align, size);

    const width = this.context.measureText(content).width;

    const left =
      align === "left"
        ? placed.x
        : align === "right"
          ? placed.x - width
          : placed.x - width / 2;

    const box = {
      left,
      right: left + width,
      top: placed.y - size / 2 - 1,
      bottom: placed.y + size / 2 + 1,
    };

    const previous = this.labelBoxes.get(element.id);

    this.labelBoxes.set(
      element.id,
      previous
        ? {
            left: Math.min(previous.left, box.left),
            right: Math.max(previous.right, box.right),
            top: Math.min(previous.top, box.top),
            bottom: Math.max(previous.bottom, box.bottom),
          }
        : box,
    );
  }

  /**
   * The designator and value beside an element's body: above it, or right of it, with
   * `reach` the body's half-width from the element's axis.
   */
  private valueLabel(element: CircuitElement, reach = 16) {
    if (!this.options.showValues) {
      return;
    }

    const lines = labelLines(element);

    if (lines.length === 0) {
      return;
    }

    const middle = interpolate(element.start, element.end, 0.5);

    const isHorizontal =
      Math.abs(element.end.x - element.start.x) >=
      Math.abs(element.end.y - element.start.y);

    if (isHorizontal) {
      this.partLabel(element, lines.join("  "), {
        x: middle.x,
        y: middle.y - reach - 6,
      });

      return;
    }

    lines.forEach((content, index) =>
      this.partLabel(
        element,
        content,
        {
          x: middle.x + reach + 4,
          y: middle.y + (index - (lines.length - 1) / 2) * (LABEL_SIZE + 2),
        },
        "left",
      ),
    );
  }

  /** The points where a body of `size` starts and ends, centered on the element. */
  private bodyEnds(element: CircuitElement, size: number) {
    const length = distance(element.start, element.end);
    const fraction = length > size ? (length - size) / 2 / length : 0;

    return [
      interpolate(element.start, element.end, fraction),
      interpolate(element.start, element.end, 1 - fraction),
    ] as const;
  }

  // Elements

  /** Draws one element in `look`, with the drawer for its kind. */
  draw(element: CircuitElement, look: ElementLook) {
    this.look = look;
    this.labelBoxes.delete(element.id);
    this.pathCurrents = element.currentPaths();

    const { context } = this;

    context.lineWidth = LINE_WIDTH;
    context.lineCap = "round";
    context.lineJoin = "round";

    this.drawers[element.kind](element);
  }

  private drawWire(element: CircuitElement) {
    const [voltage = 0] = element.volts;

    this.line(element.start, element.end, this.voltageColor(voltage));
    this.dots([element.start, element.end], 0);
  }

  private drawGround(element: CircuitElement) {
    const { start, end } = element;
    const color = this.voltageColor(0);

    this.line(start, end, color);

    for (const [index, half] of [10, 6, 2].entries()) {
      const at = interpolate(
        start,
        end,
        1 + (index * 5) / (distance(start, end) || 1),
      );

      const [a, b] = [
        interpolate(start, at, 1, half),
        interpolate(start, at, 1, -half),
      ];

      this.line(a, b, color);
    }
  }

  /** A lead that ends in a rounded tag with the net name, on the side the lead points to. */
  private drawLabel(element: CircuitElement) {
    const [voltage = 0] = element.volts;
    const text = element instanceof NetLabel ? element.text : "";
    const { context } = this;

    this.line(element.start, element.end, this.voltageColor(voltage));
    context.font = `600 ${LABEL_SIZE}px ${this.fontFamily}`;

    const width = context.measureText(text).width + 10;
    const isLeft = element.end.x < element.start.x;
    const isVertical = element.end.x === element.start.x;

    const x = isVertical
      ? element.end.x - width / 2
      : isLeft
        ? element.end.x - width
        : element.end.x;

    const y =
      isVertical && element.end.y < element.start.y
        ? element.end.y - 16
        : isVertical
          ? element.end.y
          : element.end.y - 8;

    context.strokeStyle = this.voltageColor(voltage);
    context.beginPath();
    context.roundRect(x, y, width, 16, 4);
    context.stroke();
    this.text(text, { x: x + width / 2, y: y + 8 });
  }

  private drawProbe(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 28);
    const [first = 0, second = 0] = element.volts;
    const middle = interpolate(element.start, element.end, 0.5);

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.context.strokeStyle = this.outlineColor();
    this.context.beginPath();
    this.context.arc(middle.x, middle.y, 14, 0, 2 * Math.PI);
    this.context.stroke();
    this.text("V", middle, "center", 12);

    this.valueLabel(element, 18);
  }

  /** The resistor body between `a` and `b`, shaded from one post's voltage to the other's. */
  private drawResistorBody(
    a: Point,
    b: Point,
    startVoltage: number,
    endVoltage: number,
  ) {
    if (this.options.resistorStyle === "iec") {
      const corners = [
        interpolate(a, b, 0, 6),
        interpolate(a, b, 1, 6),
        interpolate(a, b, 1, -6),
        interpolate(a, b, 0, -6),
        interpolate(a, b, 0, 6),
      ];

      this.shadedPath(corners, startVoltage, endVoltage);
    } else {
      const zigzag = [a];

      for (let index = 1; index < 8; index += 2) {
        zigzag.push(interpolate(a, b, index / 8, index % 4 === 1 ? 6 : -6));
      }

      zigzag.push(b);
      this.shadedPath(zigzag, startVoltage, endVoltage);
    }
  }

  /** An arrow from `from` to `to`, with a head at `to`, in `color`. */
  private arrow(from: Point, to: Point, color: string) {
    this.line(from, to, color);

    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    for (const spread of [-0.5, 0.5]) {
      this.line(
        to,
        {
          x: to.x - Math.cos(angle + spread) * 7,
          y: to.y - Math.sin(angle + spread) * 7,
        },
        color,
      );
    }
  }

  private drawResistor(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 32);
    const [first = 0, second = 0] = element.volts;

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.drawResistorBody(a, b, first, second);
    this.dots([element.start, element.end], 0);
    this.valueLabel(element);
  }

  private drawPotentiometer(element: CircuitElement) {
    if (!(element instanceof Potentiometer)) {
      return;
    }

    const [a, b] = this.bodyEnds(element, 32);
    const [first = 0, second = 0, wiper = 0] = element.volts;
    const contact = element.wiperContact();
    const wiperPost = element.posts()[2];

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.drawResistorBody(a, b, first, second);

    if (wiperPost) {
      this.arrow(wiperPost, contact, this.voltageColor(wiper));
      this.dots([wiperPost, contact], 2);
    }

    this.dots([element.start, contact], 0);
    this.dots([contact, element.end], 1);
    this.valueLabel(element);
  }

  private drawVariableResistor(element: CircuitElement) {
    if (!(element instanceof VariableResistor)) {
      return;
    }

    const [a, b] = this.bodyEnds(element, 32);

    this.drawResistor(element);
    this.arrow(
      interpolate(a, b, 0.2, 10),
      interpolate(a, b, 0.8, -10),
      this.outlineColor(),
    );
  }

  private drawCapacitor(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 8);
    const [first = 0, second = 0] = element.volts;

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.line(
      interpolate(a, b, 0, 12),
      interpolate(a, b, 0, -12),
      this.voltageColor(first),
    );
    this.line(
      interpolate(a, b, 1, 12),
      interpolate(a, b, 1, -12),
      this.voltageColor(second),
    );
    this.dots([element.start, a], 0);
    this.dots([b, element.end], 0);
    this.valueLabel(element, 14);
  }

  private drawInductor(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 32);
    const [first = 0, second = 0] = element.volts;
    const { context } = this;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));

    for (let index = 0; index < 4; index += 1) {
      const center = interpolate(a, b, (index + 0.5) / 4);

      context.strokeStyle = this.voltageColor(
        first + ((second - first) * (index + 0.5)) / 4,
      );
      context.beginPath();
      context.arc(
        center.x,
        center.y,
        distance(a, b) / 8,
        angle + Math.PI,
        angle,
        false,
      );
      context.stroke();
    }

    this.dots([element.start, element.end], 0);
    this.valueLabel(element);
  }

  /** A waveform's glyph inside a source's circle, `radius` wide. */
  private waveformGlyph(source: VoltageSource, center: Point, radius: number) {
    const { context } = this;
    const width = radius * 1.1;
    const height = radius * 0.45;
    const points: Point[] = [];

    for (let index = 0; index <= 24; index += 1) {
      const t = index / 24;
      const phase = t * 2 * Math.PI;
      let y = Math.sin(phase);

      if (source.waveform === "square") {
        y = t < 0.5 ? 1 : -1;
      } else if (source.waveform === "triangle") {
        y = t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4;
      } else if (source.waveform === "sawtooth") {
        y = t < 0.5 ? t * 2 : t * 2 - 2;
      } else if (source.waveform === "pulse") {
        y = t > 0.2 && t < 0.4 ? 1 : -1;
      }

      points.push({
        x: center.x - width / 2 + t * width,
        y: center.y - y * height,
      });
    }

    context.strokeStyle = this.outlineColor();
    context.lineWidth = 1.5;
    context.beginPath();
    points.forEach((point, index) =>
      index === 0
        ? context.moveTo(point.x, point.y)
        : context.lineTo(point.x, point.y),
    );
    context.stroke();
    context.lineWidth = LINE_WIDTH;
  }

  private drawVoltageSource(element: CircuitElement) {
    const [first = 0, second = 0] = element.volts;

    if (element instanceof VoltageSource && element.waveform === "dc") {
      // A battery: the long plate is the positive terminal, at the second post.
      const [a, b] = this.bodyEnds(element, 8);

      this.line(element.start, a, this.voltageColor(first));
      this.line(b, element.end, this.voltageColor(second));
      this.line(
        interpolate(a, b, 0, 6),
        interpolate(a, b, 0, -6),
        this.voltageColor(first),
      );
      this.line(
        interpolate(a, b, 1, 14),
        interpolate(a, b, 1, -14),
        this.voltageColor(second),
      );
      this.text("+", interpolate(a, b, 1.6, 14), "center", 10);
      this.dots([element.start, a], 0);
      this.dots([b, element.end], 0);
      this.valueLabel(element, 18);

      return;
    }

    const [a, b] = this.bodyEnds(element, 32);
    const center = interpolate(a, b, 0.5);

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.context.strokeStyle = this.outlineColor();
    this.context.beginPath();
    this.context.arc(center.x, center.y, 16, 0, 2 * Math.PI);
    this.context.stroke();

    if (element instanceof VoltageSource) {
      this.waveformGlyph(element, center, 16);
    }

    this.dots([element.start, a], 0);
    this.dots([b, element.end], 0);
    this.valueLabel(element, 20);
  }

  private drawRail(element: CircuitElement) {
    const [voltage = 0] = element.volts;
    const end = interpolate(element.start, element.end, 0.6);

    this.line(element.start, end, this.voltageColor(voltage));
    this.dots([end, element.start], 0);

    this.text(element.valueLabel(), element.end, "center", 12);
  }

  private drawCurrentSource(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 32);
    const [first = 0, second = 0] = element.volts;
    const center = interpolate(a, b, 0.5);

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.context.strokeStyle = this.outlineColor();
    this.context.beginPath();
    this.context.arc(center.x, center.y, 16, 0, 2 * Math.PI);
    this.context.stroke();

    // The arrow points the way the source pushes current.
    const tail = interpolate(a, b, 0.2);
    const tip = interpolate(a, b, 0.8);

    this.line(tail, tip, this.outlineColor());
    this.line(tip, interpolate(a, b, 0.6, 6), this.outlineColor());
    this.line(tip, interpolate(a, b, 0.6, -6), this.outlineColor());
    this.dots([element.start, a], 0);
    this.dots([b, element.end], 0);
    this.valueLabel(element, 20);
  }

  private drawSwitch(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 32);
    const [first = 0, second = 0] = element.volts;
    const isClosed = element instanceof Switch && element.isClosed;
    const isMomentary = element instanceof Switch && element.isMomentary;

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    this.contactDot(a, first);
    this.contactDot(b, second);

    if (isMomentary) {
      // Normally open rests above the contacts; normally closed rests under them and
      // its plunger reaches through.
      const isNormallyClosed =
        element instanceof Switch && element.isNormallyClosed;

      const bar = isNormallyClosed ? (isClosed ? -4 : -12) : isClosed ? 4 : 12;
      const top = isNormallyClosed ? 14 : bar + 10;

      this.line(
        interpolate(a, b, 0, bar),
        interpolate(a, b, 1, bar),
        this.voltageColor(first),
      );
      this.line(
        interpolate(a, b, 0.5, bar),
        interpolate(a, b, 0.5, top),
        this.outlineColor(),
      );
    } else {
      this.line(
        a,
        isClosed ? b : interpolate(a, b, 0.95, 14),
        this.voltageColor(first),
      );
    }

    if (isClosed) {
      this.dots([element.start, element.end], 0);
    }

    this.valueLabel(element, 22);
  }

  private contactDot(at: Point, voltage: number) {
    const { context } = this;

    context.fillStyle = this.voltageColor(voltage);
    context.beginPath();
    context.arc(at.x, at.y, 2.5, 0, 2 * Math.PI);
    context.fill();
  }

  /** The common lead and blade, then both throws' contacts and leads. */
  private drawSpdtSwitch(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 32);
    const [common = 0, ...throwVolts] = element.volts;
    const position = element instanceof SpdtSwitch ? element.position : 0;
    const posts = element.posts();

    // Contacts in line with the throws, so each throw's lead runs straight.
    const contacts = [
      interpolate(a, b, 1, THROW_OFFSET),
      interpolate(a, b, 1, -THROW_OFFSET),
    ];

    this.line(element.start, a, this.voltageColor(common));
    this.contactDot(a, common);

    contacts.forEach((contact, index) => {
      const post = posts[index + 1] ?? contact;
      const voltage = throwVolts[index] ?? 0;

      this.line(contact, post, this.voltageColor(voltage));
      this.contactDot(contact, voltage);
    });

    const target = contacts[position] ?? b;

    this.line(a, interpolate(a, target, 0.92), this.voltageColor(common));
    this.dots([element.start, a, target, posts[position + 1] ?? target], 0);
    this.valueLabel(element, 26);
  }

  /** A capsule: a circle with the diaphragm as a bar along one side, + at the first post. */
  private drawMicrophone(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 28);
    const [first = 0, second = 0] = element.volts;
    const center = interpolate(a, b, 0.5);
    const { context } = this;

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));
    context.strokeStyle = this.outlineColor();
    context.beginPath();
    context.arc(center.x, center.y, 14, 0, 2 * Math.PI);
    context.stroke();
    this.line(
      interpolate(a, b, 0, -14),
      interpolate(a, b, 1, -14),
      this.outlineColor(),
    );
    this.text("+", interpolate(element.start, a, 0.5, 8), "center", 10);
    this.dots([element.start, element.end], 0);
    this.valueLabel(element, 18);
  }

  /** The magnet as a box between the leads and the cone flaring from one side. */
  private drawSpeaker(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 20);
    const [first = 0, second = 0] = element.volts;
    const color = this.outlineColor();

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));

    const box = [
      interpolate(a, b, 0, -6),
      interpolate(a, b, 0, 6),
      interpolate(a, b, 1, 6),
      interpolate(a, b, 1, -6),
      interpolate(a, b, 0, -6),
    ];

    const cone = [
      interpolate(a, b, 0, 6),
      interpolate(a, b, -0.5, 18),
      interpolate(a, b, 1.5, 18),
      interpolate(a, b, 1, 6),
    ];

    for (const outline of [box, cone]) {
      for (let index = 0; index < outline.length - 1; index += 1) {
        this.line(outline[index] ?? a, outline[index + 1] ?? b, color);
      }
    }

    this.dots([element.start, element.end], 0);
    this.valueLabel(element, 22);
  }

  private drawDiode(element: CircuitElement) {
    const [a, b] = this.bodyEnds(element, 16);
    const [first = 0, second = 0] = element.volts;
    const { context } = this;

    if (element instanceof Led) {
      const glow = element.brightness();

      if (glow > 0.02) {
        const center = interpolate(a, b, 0.5);

        const color: readonly [number, number, number] = [
          element.red * 255,
          element.green * 255,
          element.blue * 255,
        ];

        context.fillStyle = rgbText(color, 0.15 + glow * 0.6);
        context.beginPath();
        context.arc(center.x, center.y, 14, 0, 2 * Math.PI);
        context.fill();
      }
    }

    this.line(element.start, a, this.voltageColor(first));
    this.line(b, element.end, this.voltageColor(second));

    const triangle = [
      interpolate(a, b, 0, 8),
      interpolate(a, b, 0, -8),
      b,
      interpolate(a, b, 0, 8),
    ];

    context.fillStyle = this.voltageColor((first + second) / 2);
    context.beginPath();
    triangle.forEach((point, index) =>
      index === 0
        ? context.moveTo(point.x, point.y)
        : context.lineTo(point.x, point.y),
    );
    context.fill();

    const isZener =
      element instanceof Diode && !(element instanceof Led) && element.isZener;

    const barTop = interpolate(a, b, 1, 8);
    const barBottom = interpolate(a, b, 1, -8);

    this.line(barTop, barBottom, this.voltageColor(second));

    if (isZener) {
      this.line(barTop, interpolate(a, b, 1.3, 10), this.voltageColor(second));
      this.line(
        barBottom,
        interpolate(a, b, 0.7, -10),
        this.voltageColor(second),
      );
    }

    if (element instanceof Led) {
      for (const along of [0.3, 0.7]) {
        const from = interpolate(a, b, along, 10);
        const to = interpolate(a, b, along + 0.3, 20);

        this.line(from, to, this.outlineColor());
      }
    }

    this.dots([element.start, element.end], 0);
    this.valueLabel(element, 14);
  }

  private drawBjt(element: CircuitElement) {
    if (!(element instanceof Bjt)) {
      return;
    }

    const [base, collector, emitter] = element.posts();
    const [vb = 0, vc = 0, ve = 0] = element.volts;

    if (!base || !collector || !emitter) {
      return;
    }

    const { start, end } = element;
    const length = distance(start, end) || 1;
    const barCenter = interpolate(start, end, 1 - 16 / length);
    const collectorSide = interpolate(barCenter, collector, 0.5);
    const emitterSide = interpolate(barCenter, emitter, 0.5);
    const barA = interpolate(barCenter, collectorSide, 1);
    const barB = interpolate(barCenter, emitterSide, 1);

    this.context.strokeStyle = this.outlineColor();
    this.context.beginPath();
    this.context.arc(
      interpolate(start, end, 1 - 8 / length).x,
      interpolate(start, end, 1 - 8 / length).y,
      20,
      0,
      2 * Math.PI,
    );
    this.context.stroke();
    this.line(start, barCenter, this.voltageColor(vb));
    this.line(barA, barB, this.voltageColor(vb));
    this.line(
      interpolate(barCenter, barA, 0.5),
      collector,
      this.voltageColor(vc),
    );
    this.line(
      interpolate(barCenter, barB, 0.5),
      emitter,
      this.voltageColor(ve),
    );

    // The emitter arrow points out of an NPN and into a PNP.
    const arrowFrom = interpolate(barCenter, barB, 0.5);

    const tip =
      element.polarity === 1
        ? interpolate(arrowFrom, emitter, 0.8)
        : interpolate(arrowFrom, emitter, 0.25);

    const back =
      element.polarity === 1
        ? interpolate(arrowFrom, emitter, 0.45)
        : interpolate(arrowFrom, emitter, 0.6);

    this.line(tip, interpolate(back, tip, 0, 5), this.voltageColor(ve));
    this.line(tip, interpolate(back, tip, 0, -5), this.voltageColor(ve));

    this.dots([start, barCenter], 0);
    this.dots([collector, interpolate(barCenter, barA, 0.5)], 1);
    this.dots([emitter, interpolate(barCenter, barB, 0.5)], 2);
    this.sideLabel(element, end, 26);
  }

  private drawMosfet(element: CircuitElement) {
    if (!(element instanceof Mosfet)) {
      return;
    }

    const [gate, source, drain] = element.posts();
    const [vg = 0, vs = 0, vd = 0] = element.volts;

    if (!gate || !source || !drain) {
      return;
    }

    const { start, end } = element;
    const length = distance(start, end) || 1;
    const plate = interpolate(start, end, 1 - 16 / length);
    const channel = interpolate(start, end, 1 - 10 / length);
    // Unit steps from the axis toward the drain and source sides.
    const toDrain = { x: (drain.x - end.x) / 16, y: (drain.y - end.y) / 16 };
    const toSource = { x: (source.x - end.x) / 16, y: (source.y - end.y) / 16 };

    const offsetBy = (point: Point, step: Point, amount: number) => ({
      x: point.x + step.x * amount,
      y: point.y + step.y * amount,
    });

    const drainChannel = offsetBy(channel, toDrain, 16);
    const sourceChannel = offsetBy(channel, toSource, 16);

    this.line(start, plate, this.voltageColor(vg));
    this.line(
      offsetBy(plate, toDrain, 14),
      offsetBy(plate, toSource, 14),
      this.voltageColor(vg),
    );

    // An enhancement channel: three segments between drain and source.
    for (const along of [0, 0.4, 0.8]) {
      this.line(
        interpolate(drainChannel, sourceChannel, along),
        interpolate(drainChannel, sourceChannel, along + 0.2),
        this.voltageColor((vs + vd) / 2),
      );
    }

    this.line(drainChannel, drain, this.voltageColor(vd));
    this.line(sourceChannel, source, this.voltageColor(vs));
    this.line(channel, end, this.voltageColor(vs));
    this.line(end, source, this.voltageColor(vs));

    // The body arrow points into an N-channel device and out of a P-channel one.
    const tip = element.polarity === 1 ? channel : end;
    const tail = element.polarity === 1 ? end : channel;

    this.line(tip, interpolate(tip, tail, 0.6, 3), this.voltageColor(vs));
    this.line(tip, interpolate(tip, tail, 0.6, -3), this.voltageColor(vs));
    this.dots([drain, drainChannel, sourceChannel, source], 2);
    this.sideLabel(element, end, 22);
  }

  private drawJfet(element: CircuitElement) {
    if (!(element instanceof Jfet)) {
      return;
    }

    const [gate, source, drain] = element.posts();
    const [vg = 0, vs = 0, vd = 0] = element.volts;

    if (!gate || !source || !drain) {
      return;
    }

    const { start, end } = element;
    const length = distance(start, end) || 1;
    const channel = interpolate(start, end, 1 - 10 / length);
    const arrowBack = interpolate(start, end, 1 - 18 / length);
    // Unit steps from the axis toward the drain and source sides.
    const toDrain = { x: (drain.x - end.x) / 16, y: (drain.y - end.y) / 16 };
    const toSource = { x: (source.x - end.x) / 16, y: (source.y - end.y) / 16 };

    const offsetBy = (point: Point, step: Point, amount: number) => ({
      x: point.x + step.x * amount,
      y: point.y + step.y * amount,
    });

    const drainChannel = offsetBy(channel, toDrain, 16);
    const sourceChannel = offsetBy(channel, toSource, 16);

    // The gate runs into a solid channel, which is never cut off by a gap as a MOSFET's.
    this.line(start, channel, this.voltageColor(vg));
    this.line(
      offsetBy(channel, toDrain, 20),
      offsetBy(channel, toSource, 20),
      this.voltageColor((vs + vd) / 2),
    );
    this.line(drainChannel, drain, this.voltageColor(vd));
    this.line(sourceChannel, source, this.voltageColor(vs));

    // The gate arrow points into an N-channel device and out of a P-channel one.
    const tip = element.polarity === 1 ? channel : arrowBack;
    const tail = element.polarity === 1 ? arrowBack : channel;

    this.line(tip, interpolate(tip, tail, 0.75, 3), this.voltageColor(vg));
    this.line(tip, interpolate(tip, tail, 0.75, -3), this.voltageColor(vg));
    this.dots([drain, drainChannel, sourceChannel, source], 2);
    this.sideLabel(element, end, 26);
  }

  private drawOpAmp(element: CircuitElement) {
    if (!(element instanceof OpAmp)) {
      return;
    }

    const [inverting, nonInverting, output] = element.posts();
    const [vm = 0, vp = 0, vo = 0] = element.volts;

    if (!inverting || !nonInverting || !output) {
      return;
    }

    const { start, end } = element;
    const length = distance(start, end) || 1;
    const baseCenter = interpolate(start, end, 16 / length);
    const tip = interpolate(start, end, 1 - 16 / length);

    const invertingBase = {
      x: baseCenter.x + inverting.x - start.x,
      y: baseCenter.y + inverting.y - start.y,
    };

    const nonInvertingBase = {
      x: baseCenter.x + nonInverting.x - start.x,
      y: baseCenter.y + nonInverting.y - start.y,
    };

    const { context } = this;

    const corners = [
      interpolate(baseCenter, tip, 0, 32),
      interpolate(baseCenter, tip, 0, -32),
      tip,
    ];

    context.strokeStyle = this.outlineColor();
    context.beginPath();
    corners.forEach((point, index) =>
      index === 0
        ? context.moveTo(point.x, point.y)
        : context.lineTo(point.x, point.y),
    );
    context.closePath();
    context.stroke();
    this.line(inverting, invertingBase, this.voltageColor(vm));
    this.line(nonInverting, nonInvertingBase, this.voltageColor(vp));
    this.line(tip, output, this.voltageColor(vo));
    this.text("−", interpolate(invertingBase, tip, 0.12), "center", 14);
    this.text("+", interpolate(nonInvertingBase, tip, 0.12), "center", 14);
    this.dots([tip, output], 2);
    this.sideLabel(element, interpolate(baseCenter, tip, 0.5), 38);
  }

  /** A buffer triangle with the hysteresis loop inside, and a bubble when it inverts. */
  private drawSchmittTrigger(element: CircuitElement) {
    if (!(element instanceof SchmittTrigger)) {
      return;
    }

    const [base, end] = this.bodyEnds(element, 32);
    const [vi = 0, vo = 0] = element.volts;
    const { context } = this;
    const bodyLength = distance(base, end) || 1;
    const bubble = element.isInverting ? SCHMITT_BUBBLE_RADIUS : 0;
    const tip = interpolate(base, end, 1 - (2 * bubble) / bodyLength);

    const corners = [
      interpolate(base, tip, 0, 16),
      interpolate(base, tip, 0, -16),
      tip,
    ];

    this.line(element.start, base, this.voltageColor(vi));
    this.line(end, element.end, this.voltageColor(vo));
    context.strokeStyle = this.outlineColor();
    context.beginPath();
    corners.forEach((point, index) =>
      index === 0
        ? context.moveTo(point.x, point.y)
        : context.lineTo(point.x, point.y),
    );
    context.closePath();
    context.stroke();

    if (bubble > 0) {
      const center = interpolate(tip, end, 0.5);

      context.beginPath();
      context.arc(center.x, center.y, bubble, 0, 2 * Math.PI);
      context.stroke();
    }

    // The hysteresis loop stays upright: two steps that overlap in the middle.
    const { x, y } = interpolate(base, tip, 0.33);

    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x - 6, y + 4);
    context.lineTo(x + 2, y + 4);
    context.lineTo(x + 2, y - 4);
    context.lineTo(x + 6, y - 4);
    context.moveTo(x - 2, y + 4);
    context.lineTo(x - 2, y - 4);
    context.lineTo(x + 2, y - 4);
    context.stroke();
    context.lineWidth = LINE_WIDTH;
    this.dots([end, element.end], 0);
    this.valueLabel(element, 20);
  }

  private drawRegulator(element: CircuitElement) {
    if (!(element instanceof LinearRegulator)) {
      return;
    }

    const [input, output, ground] = element.posts();
    const [vi = 0, vo = 0, vg = 0] = element.volts;

    if (!input || !output || !ground) {
      return;
    }

    const length = distance(input, output) || 1;
    const left = interpolate(input, output, 16 / length);
    const right = interpolate(input, output, 1 - 16 / length);

    // 1 when GND sits on the side `interpolate` offsets toward, -1 otherwise.
    const side =
      distance(interpolate(left, right, 0.5, 16), ground) <
      distance(interpolate(left, right, 0.5, -16), ground)
        ? 1
        : -1;

    const corners = [
      interpolate(left, right, 0, 16),
      interpolate(left, right, 1, 16),
      interpolate(left, right, 1, -16),
      interpolate(left, right, 0, -16),
    ];

    const { context } = this;

    context.strokeStyle = this.outlineColor();
    context.beginPath();
    corners.forEach((point, index) =>
      index === 0
        ? context.moveTo(point.x, point.y)
        : context.lineTo(point.x, point.y),
    );
    context.closePath();
    context.stroke();
    this.line(input, left, this.voltageColor(vi));
    this.line(right, output, this.voltageColor(vo));
    this.line(
      interpolate(left, right, 0.5, 16 * side),
      ground,
      this.voltageColor(vg),
    );
    this.text("IN", interpolate(left, right, 0.18), "center", 8);
    this.text("OUT", interpolate(left, right, 0.8), "center", 8);
    this.text(
      element.isAdjustable() ? "ADJ" : "GND",
      interpolate(left, right, 0.5, 9 * side),
      "center",
      8,
    );

    this.dots([input, left], 0);
    this.dots([output, right], 1);
    this.sideLabel(element, interpolate(left, right, 0.5, -16 * side), 4);
  }

  private drawTimer(element: CircuitElement) {
    const { context } = this;
    const x = element.x1;
    const y = element.y1;

    context.strokeStyle = this.outlineColor();
    context.beginPath();
    context.roundRect(x, y, TIMER_SIZE.width, TIMER_SIZE.height, 3);
    context.stroke();
    this.text("555", { x: x + TIMER_SIZE.width / 2, y: y + 38 }, "center", 13);

    const posts = element.posts();

    TIMER_PINS.forEach((pin, index) => {
      const post = posts[index] ?? { x: x + pin.x, y: y + pin.y };

      const edge = {
        x: Math.min(Math.max(post.x, x), x + TIMER_SIZE.width),
        y: Math.min(Math.max(post.y, y), y + TIMER_SIZE.height),
      };

      // Side pins align their labels to their edge, so DIS clears VCC above it.
      const isSide = post.x < x || post.x > x + TIMER_SIZE.width;

      const align: CanvasTextAlign = !isSide
        ? "center"
        : post.x < x
          ? "left"
          : "right";

      const label = {
        x: isSide ? edge.x + (post.x < x ? 4 : -4) : edge.x,
        y: isSide ? edge.y : edge.y + (post.y < y ? 8 : -8),
      };

      this.line(post, edge, this.voltageColor(element.volts[index] ?? 0));
      this.text(pin.name, label, align, 7);
      this.dots([post, edge], index);
    });

    // Labels sit inside the body under its name, clear of every pin and wire.
    if (this.options.showValues) {
      labelLines(element).forEach((content, line) =>
        this.partLabel(
          element,
          content,
          { x: x + TIMER_SIZE.width / 2, y: y + 56 + line * 11 },
          "center",
          9,
        ),
      );
    }
  }

  /** Designator and part name above `at`, for multi-post parts. */
  private sideLabel(element: CircuitElement, at: Point, reach: number) {
    if (!this.options.showValues) {
      return;
    }

    this.partLabel(element, labelLines(element).join("  "), {
      x: at.x,
      y: at.y - reach - 4,
    });
  }

  // Overlays

  /** A filled dot for junctions of three or more posts, a ring for loose posts. */
  post(point: Point, voltage: number, count: number) {
    const { context } = this;

    this.look = { accent: null, dotOffsets: [] };

    if (count >= 3) {
      context.fillStyle = this.voltageColor(voltage);
      context.beginPath();
      context.arc(point.x, point.y, 3.5, 0, 2 * Math.PI);
      context.fill();
    } else if (count === 1) {
      context.strokeStyle = this.voltageColor(voltage);
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(point.x, point.y, 3, 0, 2 * Math.PI);
      context.stroke();
    }
  }

  /** A ring around the point where a click would join or start a wire. */
  snapRing(point: Point) {
    const { context } = this;

    context.strokeStyle = this.palette.primary;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(point.x, point.y, 6, 0, 2 * Math.PI);
    context.stroke();
  }

  /** A square handle on a selected element's draggable end. */
  handle(point: Point) {
    const { context } = this;

    context.fillStyle = this.palette.card;
    context.strokeStyle = this.palette.primary;
    context.lineWidth = 1.5;
    context.beginPath();
    context.rect(point.x - 4, point.y - 4, 8, 8);
    context.fill();
    context.stroke();
  }

  /** A wide, faint band under a wire of the net under the pointer. */
  netBand(a: Point, b: Point) {
    const { context } = this;

    context.save();
    context.globalAlpha = 0.25;
    context.lineWidth = 8;
    context.lineCap = "round";
    this.line(a, b, this.palette.primary);
    context.restore();
  }

  /** A net's operating-point voltage in a small tag up and right of `at`. */
  voltageTag(at: Point, content: string) {
    const { context } = this;
    const size = 10;

    context.font = `${size}px ${this.palette.codeFontFamily}`;

    const width = context.measureText(content).width + 8;
    const left = at.x + 4;
    const top = at.y - size - 10;

    context.fillStyle = this.palette.card;
    context.strokeStyle = this.palette.border;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(left, top, width, size + 6, 3);
    context.fill();
    context.stroke();
    context.fillStyle = rgbText(this.palette.foreground);
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(content, left + 4, top + (size + 6) / 2);
  }
}
