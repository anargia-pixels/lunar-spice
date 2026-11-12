import { TRACE_COUNT } from "./trace-colors";

/** A color as red, green and blue from 0 to 255. */
type Rgb = readonly [number, number, number];

/** The theme's colors resolved for canvas drawing, which cannot read CSS variables. */
export type CanvasPalette = {
  background: string;
  foreground: Rgb;
  muted: Rgb;
  primary: string;
  /** Marks the parts behind a simulation error. */
  destructive: string;
  border: string;
  card: string;
  positive: Rgb;
  negative: Rgb;
  currentDot: string;
  /** Plot trace colors in their fixed order. */
  traces: readonly string[];
  fontFamily: string;
  /** Equal-width digits, for numbers that change under the pointer. */
  codeFontFamily: string;
  /** Schematic text when the display options pick the mono font. */
  schematicMonoFamily: string;
};

/** The one-pixel canvas that `toRgb` paints on, made on first use. */
let probe: CanvasRenderingContext2D | null = null;

/**
 * Resolves any CSS color (hex, rgb, oklch, …) to RGB by painting one pixel. Returns gray
 * when the browser has no 2D canvas.
 */
function toRgb(color: string): Rgb {
  probe ??= document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });

  if (!probe) {
    return [128, 128, 128];
  }

  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);

  const [red = 0, green = 0, blue = 0] = probe.getImageData(0, 0, 1, 1).data;

  return [red, green, blue];
}

/** `rgb()` CSS text for a color, with `alpha` from 0 to 1. */
export function rgbText([red, green, blue]: Rgb, alpha = 1) {
  return alpha === 1
    ? `rgb(${red} ${green} ${blue})`
    : `rgb(${red} ${green} ${blue} / ${alpha})`;
}

/** Mixes `from` toward `to` by `amount` from 0 to 1. */
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

/** Reads the palette from the theme variables on the document root. */
function readCanvasPalette(): CanvasPalette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
  const solid = (name: string) => rgbText(toRgb(token(name)));

  return {
    background: solid("background"),
    foreground: toRgb(token("foreground")),
    muted: toRgb(token("muted-foreground")),
    primary: solid("primary"),
    destructive: solid("destructive"),
    border: solid("border"),
    card: solid("card"),
    positive: toRgb(token("voltage-positive")),
    negative: toRgb(token("voltage-negative")),
    currentDot: solid("current-dot"),
    traces: Array.from({ length: TRACE_COUNT }, (_, index) =>
      solid(`trace-${index + 1}`),
    ),
    fontFamily: style.getPropertyValue("--font-ui").trim() || "sans-serif",
    codeFontFamily: style.getPropertyValue("--font-code").trim() || "monospace",
    schematicMonoFamily:
      style.getPropertyValue("--font-schematic-mono").trim() || "monospace",
  };
}

/** The trace color for slot `slot`, in the order `traceSwatch` names them. */
export function traceColor(palette: CanvasPalette, slot: number) {
  return palette.traces[slot % palette.traces.length] ?? palette.primary;
}

/** The palette, read once per theme change; null until first asked for or after a change. */
let cached: CanvasPalette | null = null;

const listeners = new Set<() => void>();

let observer: MutationObserver | null = null;

/**
 * Starts watching the theme. The theme provider writes the light or dark class and the
 * color theme variables onto the document root, so a change to its attributes is a new
 * palette.
 */
function observeTheme() {
  observer ??= new MutationObserver(() => {
    cached = null;

    for (const listener of listeners) {
      listener();
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
}

/** The theme's colors for canvas drawing, read once per theme change. */
export function canvasPalette() {
  if (!cached) {
    observeTheme();
    cached = readCanvasPalette();
  }

  return cached;
}

/** Calls `onChange` after the theme changes; returns a function that stops it. */
export function watchPalette(onChange: () => void) {
  observeTheme();
  listeners.add(onChange);

  return () => {
    listeners.delete(onChange);
  };
}
