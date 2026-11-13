/** Resistor symbols and how the appearance settings name them. */
export const RESISTOR_STYLES = {
  us: "Zigzag (US)",
  iec: "Rectangle (IEC)",
} as const;

export type ResistorStyle = keyof typeof RESISTOR_STYLES;

/** How the canvas draws its grid and how the appearance settings name each way. */
export const GRID_STYLES = {
  dots: "Dots",
  lines: "Lines",
} as const;

export type GridStyle = keyof typeof GRID_STYLES;

/** The grid styles in the order pickers list them. */
export const GRID_STYLE_KEYS = Object.keys(GRID_STYLES).filter(
  (key): key is GridStyle => key in GRID_STYLES,
);

/** The fonts schematic text can use and how the appearance settings name them. */
export const SCHEMATIC_FONTS = {
  sans: "Sans (Poppins)",
  mono: "Mono (JetBrains Mono)",
} as const;

export type SchematicFont = keyof typeof SCHEMATIC_FONTS;

/** The schematic fonts in the order pickers list them. */
export const SCHEMATIC_FONT_KEYS = Object.keys(SCHEMATIC_FONTS).filter(
  (key): key is SchematicFont => key in SCHEMATIC_FONTS,
);

/** How the schematic draws, as the appearance settings choose it. */
export type DisplayOptions = {
  /** Shade wires and parts by voltage, as Falstad does. */
  showVoltageColors: boolean;
  showCurrentDots: boolean;
  /** Designators and values beside each part. */
  showValues: boolean;
  /** Each net's name, such as `n12`, as analysis results call it. */
  showNetNames: boolean;
  showGrid: boolean;
  /** A dot at each grid point, or lines along the grid. */
  gridStyle: GridStyle;
  resistorStyle: ResistorStyle;
  /** The font of designators, values and net names. */
  schematicFont: SchematicFont;
};

export const DEFAULT_DISPLAY: DisplayOptions = {
  showVoltageColors: true,
  showCurrentDots: true,
  showValues: true,
  showNetNames: false,
  showGrid: true,
  gridStyle: "dots",
  resistorStyle: "us",
  schematicFont: "sans",
};
