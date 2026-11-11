// The Cloudflare stack for `bun run deploy`: the web app.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import names from "./names.json" with { type: "json" };

/** Settings every Worker shares. */
const WORKER_DEFAULTS = {
  compatibility: { date: "2026-10-01" },
  workersDev: false, // workers.dev hosts only draw bot scans
};

// Web app: landing page and the browser simulator, prerendered as static assets

const web = Cloudflare.Website.Vite("web", {
  ...WORKER_DEFAULTS,
  name: "lunar-spice",
  compatibility: { ...WORKER_DEFAULTS.compatibility, flags: ["nodejs_compat"] },
  rootDir: "../../apps/web",
  memo: {
    include: ["**/*", "../../assets/icons/**"], // the served-files plugin copies the icons
    lockfile: true,
  },
  assets: {
    notFoundHandling: "none", // only paths no asset matches reach the Worker
  },
  domain: names.webDomain,
});

// Stack

export default Alchemy.Stack(
  "lunar-spice",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const webWorker = yield* web;

    return {
      web: webWorker.url,
    };
  }),
);
