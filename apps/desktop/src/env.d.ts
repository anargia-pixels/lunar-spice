/// <reference types="vite/client" />

/** The desktop package version, set by electron-vite at build time. */
declare const __APP_VERSION__: string;

interface Window {
  lunarSpice: import("./lib/bridge").LunarSpiceApi; // Set by the preload script.
}
