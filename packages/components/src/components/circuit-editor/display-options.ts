/** Resistor symbols and how the appearance settings name them. */
export const RESISTOR_STYLES = {
  us: "Zigzag (US)",
  iec: "Rectangle (IEC)",
} as const;

export type ResistorStyle = keyof typeof RESISTOR_STYLES;

/** How the schematic draws, as the appearance settings choose it. */
export type DisplayOptions = {
  /** Shade wires and parts by voltage, as Falstad does. */
  showVoltageColors: boolean;
  showCurrentDots: boolean;
  /** Designators and values beside each part. */
  showValues: boolean;
  showGrid: boolean;
  resistorStyle: ResistorStyle;
};

export const DEFAULT_DISPLAY: DisplayOptions = {
  showVoltageColors: true,
  showCurrentDots: true,
  showValues: true,
  showGrid: true,
  resistorStyle: "us",
};
