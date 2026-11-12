# Lunar Spice

Bun + Turborepo monorepo for an Electron circuit simulator. Versions live in the root
`package.json` catalog; workspaces reference them with `catalog:`. When naming a concept
in code, UI copy, docs or conversation, use the terms in [GLOSSARY.md](GLOSSARY.md).

## Layout

- `apps/desktop`: Electron via electron-vite. `main.tsx` hands the preload's file API, its
  About rows and Storage pane to `setPlatform` and renders the shared app; `electron/`
  holds main and preload. IPC channels are typed once in `lib/bridge.ts`.
- `apps/web`: TanStack Start with Next.js app-router routes in `src/app/` (rules in
  `tsr.config.json`): `page.tsx` is an index route, `layout.tsx` a layout. `(site)/` is
  the landing page; `app/` is the simulator at `/app`, which skips SSR and lazy-loads
  `editor.tsx`. Saved circuits live in IndexedDB (`lib/browser-circuits.ts`). Every page
  is listed in `pages` in `vite.config.ts` and prerendered at build time. `packages/infra`
  deploys it as the `lunar-spice` Worker on a release tag.
- `packages/app`: the app both platforms run: shell, menu bar, simulation and results
  panels, settings panes and the zustand stores. Analyses run in `lib/analysis-worker.ts`,
  off the UI thread. Each app supplies storage, file opening, its About rows and its
  Storage pane through `Platform` in `lib/platform.ts`. Saved circuits are named by
  `freeName` in `lib/circuit-files.ts` on every platform.
- `packages/simulator`: the engine, pure TypeScript with no DOM or React. Modified nodal
  analysis (`mna-system.ts`, `simulation.ts`), elements in `elements/`, the four analyses
  in `analyses.ts`, the circuit file format in `circuit.ts`, examples in `examples.ts`.
  `wiring.ts` cuts wires where a post lands on them; the editor runs it after every edit,
  since posts only join at the same point. Tests in `test/` run with `bun test`.
- `packages/components`: shared UI. `src/components/ui/` is shadcn (Base UI);
  `circuit-editor/` is the canvas editor: `editor-controller.ts` owns the document,
  selection and gestures and composes `camera.ts`, `editor-history.ts`,
  `interactive-run.ts` (the live simulation, scopes and sound), `attached-wires.ts` (wires
  that follow a moved selection) and `render-scene.ts`; `plots/` and `analysis/` draw
  results. `src/lib/` holds what several of them share: the canvas palette and trace
  colors, scopes, and keyboard shortcuts. `src/styles/globals.css` is the theme.
- `packages/utils`: shared libs without DOM or React (`cn`, fonts).
- `packages/infra`: the Alchemy stack (`alchemy.run.ts`) for the web app only: one
  `lunar-spice` Worker serving `apps/web` prerendered, on `lunarspice.doctorthe113.com`
  (`names.json`). `bun run deploy` in that package deploys by hand.
- `tools/oxlint`: custom lint rules, including `anti-slop/*`.

## Conventions

- Every file name is lowercase kebab-case, components included.
- UI uses shadcn components from `@lunar-spice/components/ui/*` for every control; plain
  `div`/`span`/`header` only for layout. The UI follows Lunarscribe's look and feel.
- Shared components stay state-agnostic: they take props and callbacks. App state
  (zustand) lives in `packages/app`; anything that differs by platform goes through
  `Platform`.
- Circuit files are Falstad's text format, so Falstad exports open directly. Values
  Falstad does not write (ESR, model parameters) go after Falstad's on the same line,
  behind `EXTENDED_FORMAT_FLAG`; never reorder Falstad's fields.
- Components stay few; realism comes from datasheet parameters on each one: presets of
  real parts plus a pasted SPICE `.model`. Every new model gets a `bun test` check against
  a hand-calculated result.
- Canvas shortcuts follow Inkscape (arrows, `[` `]`, H/V, digits for zoom, Ctrl+D). Each
  shortcut is declared once: canvas commands in `circuit-editor/commands.ts`, tool letters
  in `circuit-editor/tools.ts` (avoiding Inkscape's keys), app shortcuts in
  `packages/app/src/lib/app-commands.ts`. Key handling, tooltips, menus and the shortcuts
  dialog all read those tables.
- A new component is a class in `packages/simulator/src/elements/` registered in
  `ELEMENT_CLASSES` (`circuit.ts`), a drawer in `draw-elements.ts`, and a tool with a
  glyph. Generic code asks elements for capabilities (`isNetElement`, `isToggle`,
  `drivesAc`, `currentPaths`, `power`) instead of checking their kind.
- Plot colors use the `--trace-*` tokens in fixed order, one y axis per plot; voltages and
  currents go in separate plots.
- Theme: light palette is user-defined, dark is Catppuccin Mocha. Fonts are Poppins and
  Roboto Mono, bundled from `packages/utils/src/fonts` so they render offline.
- Change only what the request names. When a UI term is ambiguous, ask before editing.
- Commit on the current branch. Ask before committing or creating a new branch.
- Releases and the web deploy run from version tags, never from a push to `master`. When
  releasing a new version, read the [release checklist](RELEASE.md) and follow the steps
  in order.
- The desktop app is developed for Linux and macOS; Windows is not supported yet. The web
  app targets current Chromium, Firefox and Safari.

## shadcn

Run `bunx shadcn add <name>` inside `packages/components`. The CLI imports `cn` from the
`cn` package: rewrite that to `@lunar-spice/utils/cn` and remove the `"cn"` dependency it
adds.

## Verify

`bun run format`, `bun run lint`, `bun run check-types`, `bun run test`, plus
`bun run build` for cross-package changes. Oxlint is the coding standard: fix diagnostics
in the code, never suppress them.

## Gotchas

- An inherited `ELECTRON_RUN_AS_NODE=1` makes Electron fail with "does not provide an
  export named BrowserWindow"; launch with `env -u ELECTRON_RUN_AS_NODE`.
- `bunfig.toml` blocks packages newer than 7 days; add exemptions to
  `minimumReleaseAgeExcludes`.
- Nonlinear models must set `system.converged = false` while their linearization point
  still moves, or Newton stops one iteration early with a wrong answer. Piecewise models
  (op-amp clipping, regulator current limit) also need a region check; see
  `VoltageRegulator.stampStep`.
