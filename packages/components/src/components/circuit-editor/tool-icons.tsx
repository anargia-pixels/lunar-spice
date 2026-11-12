import type { ReactNode } from "react";

import type { ToolId } from "./tools";

/**
 * Schematic symbols drawn as 24 px stroke icons at Hugeicons' 1.5 px weight. Arrowheads
 * are filled triangles: stroked ones close up into blobs at this size.
 */
const GLYPHS: Record<ToolId | "more", ReactNode> = {
  select: <path d="M6 3.5 18 12l-5.4 1.1L15.6 19l-2.4 1.2-3-5.9L6 18Z" />,
  wire: (
    <>
      <path d="M3 17h7V7h11" />
      <circle cx="10" cy="17" r="1.25" fill="currentColor" />
    </>
  ),
  resistor: <path d="M2 12h4l1.5-4 3 8 3-8 3 8 1.5-4h4" />,
  potentiometer: (
    <>
      <path d="M2 16h4l1.5-4 3 8 3-8 3 8 1.5-4h4M12 3v4" />
      <path d="M12 10.5 10 7h4Z" fill="currentColor" />
    </>
  ),
  "variable-resistor": (
    <>
      <path d="M2 14h4l1.5-4 3 8 3-8 3 8 1.5-4h4M6 21 16.6 6.5" />
      <path d="m18 4.6-2.7 1.3 2.3 1.7Z" fill="currentColor" />
    </>
  ),
  capacitor: <path d="M2 12h8.5M10.5 6v12M13.5 6v12M13.5 12H22" />,
  inductor: (
    <path d="M2 13h2.5a2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 5 0H22" />
  ),
  "dc-source": <path d="M12 2v8M6 10h12M9 14h6M12 14v8M18 3v4M16 5h4" />,
  "ac-source": (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M8.5 12c1-2.5 2.5-2.5 3.5 0s2.5 2.5 3.5 0" />
    </>
  ),
  ground: <path d="M12 3v9M5 12h14M8 15.5h8M10.5 19h3" />,
  switch: (
    <>
      <path d="M2 15h4M18 15h4M7.5 14.5 16 8" />
      <circle cx="7" cy="15" r="1.25" fill="currentColor" />
      <circle cx="17" cy="15" r="1.25" fill="currentColor" />
    </>
  ),
  "push-switch": (
    <>
      <path d="M2 16h4.5M17.5 16H22M5 11.5h14M12 11.5V5M9.5 5h5" />
      <circle cx="6.5" cy="16" r="1.25" fill="currentColor" />
      <circle cx="17.5" cy="16" r="1.25" fill="currentColor" />
    </>
  ),
  "push-switch-nc": (
    <>
      <path d="M2 10h4.5M17.5 10H22M5 12.5h14M12 12.5V4M9.5 4h5" />
      <circle cx="6.5" cy="10" r="1.25" fill="currentColor" />
      <circle cx="17.5" cy="10" r="1.25" fill="currentColor" />
    </>
  ),
  "spdt-switch": (
    <>
      <path d="M2 12h4M7.5 11.5 16.5 7M18 7h4M18 17h4" />
      <circle cx="7" cy="12" r="1.25" fill="currentColor" />
      <circle cx="17" cy="7" r="1.25" fill="currentColor" />
      <circle cx="17" cy="17" r="1.25" fill="currentColor" />
    </>
  ),
  microphone: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M6 6v12M12 2v4M12 18v4" />
    </>
  ),
  speaker: (
    <path d="M3 9h4v6H3ZM7 9l6-5v16l-6-5M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10" />
  ),
  diode: <path d="M2 12h6M16 12h6M8 6v12l8-6ZM16 6v12" />,
  led: (
    <>
      <path d="M2 15h6M16 15h6M8 10v10l8-5ZM16 10v10M11 8l3.8-3.8M17 8l2.8-2.8" />
      <path d="m16 3-2.5.7 1.8 1.8ZM21 4l-2.5.7 1.8 1.8Z" fill="currentColor" />
    </>
  ),
  npn: (
    <>
      <circle cx="13" cy="12" r="8" />
      <path d="M2 12h7M9 7.5v9M9 10l6-3.5V2M9 14l6 3.5V22" />
      <path d="m14.2 17-1.2-2.5-1.6 2.8Z" fill="currentColor" />
    </>
  ),
  pnp: (
    <>
      <circle cx="13" cy="12" r="8" />
      <path d="M2 12h7M9 7.5v9M9 10l6-3.5V2M9 14l6 3.5V22" />
      <path d="m11.1 15.2 1.2 2.5 1.6-2.7Z" fill="currentColor" />
    </>
  ),
  nmos: (
    <>
      <path d="M2 12h5M7 6v12M10 5v3M10 10.5v3M10 16v3M10 6.5h6V2M10 17.5h6V22M10 12h6v5.5" />
      <path d="m10.8 12 2.8-1.6v3.2Z" fill="currentColor" />
    </>
  ),
  pmos: (
    <>
      <path d="M2 12h5M7 6v12M10 5v3M10 10.5v3M10 16v3M10 6.5h6V2M10 17.5h6V22M10 12h6v5.5" />
      <path d="m15.2 12-2.8-1.6v3.2Z" fill="currentColor" />
    </>
  ),
  njfet: (
    <>
      <path d="M2 12h8M10 5v14M10 7h6V2M10 17h6v5" />
      <path d="M9.3 12 7 10.7v2.6Z" fill="currentColor" />
    </>
  ),
  pjfet: (
    <>
      <path d="M2 12h8M10 5v14M10 7h6V2M10 17h6v5" />
      <path d="m4 12 2.3-1.3v2.6Z" fill="currentColor" />
    </>
  ),
  "op-amp": (
    <path d="M5 3.5v17l15-8.5ZM2 8h3M2 16h3M20 12h2M7 8h2.5M6.8 16h2.2M7.9 14.75v2.5" />
  ),
  "schmitt-trigger": (
    <path d="M4 3v18l16-9ZM1 12h3M20 12h3M6.5 14.5H11V10h1M8 14.5V10h3" />
  ),
  "inverting-schmitt-trigger": (
    <>
      <path d="M3 3v18l15-9ZM5.5 14.5H10V10h1M7 14.5V10h3M21.8 12H23" />
      <circle cx="20" cy="12" r="1.8" />
    </>
  ),
  rail: <path d="M12 22V9M7 9l5-6 5 6" />,
  "current-source": (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M12 16V10" />
      <path d="m12 7.5-2.2 3.2h4.4Z" fill="currentColor" />
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
      <circle cx="5" cy="12" r="1.25" fill="currentColor" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
      <circle cx="19" cy="12" r="1.25" fill="currentColor" />
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
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5"
    >
      {GLYPHS[toolId]}
    </svg>
  );
}
