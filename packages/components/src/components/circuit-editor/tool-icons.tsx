import type { ReactNode } from "react";

import type { ToolId } from "./tools";

/**
 * Schematic symbols drawn as 24 px stroke icons at Hugeicons' 2 px weight, which also
 * matches the canvas's 2 px schematic lines.
 */
const GLYPHS: Record<ToolId | "more", ReactNode> = {
  select: <path d="M6 3.5 18 12l-5.4 1.1L15.6 19l-2.4 1.2-3-5.9L6 18Z" />,
  wire: (
    <>
      <path d="M3 17h7V7h11" />
      <circle cx="10" cy="17" r="1" fill="currentColor" />
    </>
  ),
  resistor: <path d="M2 12h4l1.5-4 3 8 3-8 3 8 1.5-4h4" />,
  capacitor: <path d="M2 12h8.5M10.5 6v12M13.5 6v12M13.5 12H22" />,
  inductor: (
    <path d="M2 13h2.5a2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 5 0H22" />
  ),
  "dc-source": <path d="M12 2v8M6 10h12M9 14h6M12 14v8M17 5h3M18.5 3.5v3" />,
  "ac-source": (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M8.5 12c1-2.5 2.5-2.5 3.5 0s2.5 2.5 3.5 0" />
    </>
  ),
  ground: <path d="M12 3v9M5 12h14M8 15.5h8M10.5 19h3" />,
  switch: (
    <>
      <path d="M2 15h5M17 15h5M7.5 14.5 16 8" />
      <circle cx="7" cy="15" r="1" fill="currentColor" />
      <circle cx="17" cy="15" r="1" fill="currentColor" />
    </>
  ),
  "push-switch": <path d="M2 16h5M17 16h5M6 12h12M12 12V6M7 16v-1M17 16v-1" />,
  "push-switch-nc": <path d="M2 10h5M17 10h5M7 10v2M17 10v2M6 13h12M12 13V4" />,
  "spdt-switch": (
    <>
      <path d="M2 12h5M7.5 11.5 16.5 7M17 7h5M17 17h5" />
      <circle cx="7" cy="12" r="1" fill="currentColor" />
      <circle cx="17" cy="7" r="1" fill="currentColor" />
      <circle cx="17" cy="17" r="1" fill="currentColor" />
    </>
  ),
  microphone: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M6 6v12M12 2v4M12 18v4" />
    </>
  ),
  speaker: <path d="M12 2v6M12 16v6M9 8h4v8H9ZM13 8l5-4v16l-5-4" />,
  diode: <path d="M2 12h6M16 12h6M8 6v12l8-6ZM16 6v12" />,
  led: (
    <path d="M2 14h6M16 14h6M8 8v12l8-6ZM16 8v12M13 6l3-3M16 3h-2M16 3v2M17.5 8l3-3M20.5 5h-2M20.5 5v2" />
  ),
  npn: (
    <>
      <circle cx="13" cy="12" r="8" />
      <path d="M2 12h8M10 7v10M10 10l6-4M10 14l6 4M16 18l-2.6-.4M16 18l-1-2.4" />
    </>
  ),
  pnp: (
    <>
      <circle cx="13" cy="12" r="8" />
      <path d="M2 12h8M10 7v10M10 10l6-4M10 14l6 4M10.5 14.3l2.4.4M10.5 14.3l.9 2.2" />
    </>
  ),
  nmos: (
    <path d="M2 14h6M8 7v10M11 6v3M11 10.5v3M11 15v3M11 7.5h6V3M11 16.5h6V21M11 12h6v4.5M11 12l2.5-1.5M11 12l2.5 1.5" />
  ),
  pmos: (
    <path d="M2 14h6M8 7v10M11 6v3M11 10.5v3M11 15v3M11 7.5h6V3M11 16.5h6V21M11 12h6v-4.5M17 12l-2.5-1.5M17 12l-2.5 1.5" />
  ),
  "op-amp": <path d="M6 4v16l13-8ZM2 8h4M2 16h4M19 12h3M8 8h2M8 16h2M9 15v2" />,
  "schmitt-trigger": (
    <path d="M6 4v16l13-8ZM2 12h4M19 12h3M8 14h4v-4h1.5M10 14v-4h2" />
  ),
  "inverting-schmitt-trigger": (
    <>
      <path d="M6 4v16l11-8ZM2 12h4M21 12h1M8 14h3.5v-4H13M9.5 14v-4h2" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
  rail: <path d="M12 22V9M7 9l5-6 5 6" />,
  "current-source": (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M12 16V8M9 11l3-3 3 3" />
    </>
  ),
  regulator: (
    <>
      <rect x="5" y="6" width="14" height="9" rx="1" />
      <path d="M1 10h4M19 10h4M12 15v6" />
    </>
  ),
  "adjustable-regulator": (
    <>
      <rect x="5" y="6" width="14" height="9" rx="1" />
      <path d="M1 10h4M19 10h4M12 15v6M8 13l8-5M16 8h-2.5M16 8v2.5" />
    </>
  ),
  timer: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="1.5" />
      <path d="M3 7h3M3 12h3M3 17h3M18 7h3M18 12h3M18 17h3" />
    </>
  ),
  probe: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M9 9l3 6 3-6" />
    </>
  ),
  label: <path d="M2 12h5M7 8h9l4 4-4 4H7Z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
};

/** The schematic symbol for a tool, by tool id; `more` is the More menu's. */
export function ToolIcon({ toolId }: { toolId: ToolId | "more" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4"
    >
      {GLYPHS[toolId]}
    </svg>
  );
}
