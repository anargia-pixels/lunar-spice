/** Spring transitions for framer-motion, from fastest to slowest. */
export const spring = {
  fast: {
    type: "spring" as const,
    duration: 0.08,
    bounce: 0,
    exit: { duration: 0.06 },
  },
  /**
   * Critically damped: as quick to the eye as a bouncier spring, but it lands with no
   * overshoot. For short travel and for surfaces that must settle exactly, such as
   * dropdowns, tabs, drawers and merged selection backgrounds.
   */
  moderate: {
    type: "spring" as const,
    duration: 0.16,
    bounce: 0,
    exit: { duration: 0.12 },
  },
  /**
   * Icon swaps, such as Run and Pause: long enough to read as one icon turning into the
   * other, without overshoot.
   */
  swap: {
    type: "spring" as const,
    duration: 0.3,
    bounce: 0,
  },
} as const;
