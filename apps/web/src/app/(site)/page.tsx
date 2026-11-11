import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@lunar-spice/components/ui/button";
import { createFileRoute, Link } from "@tanstack/react-router";

import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/(site)/")({
  head: () =>
    pageHead({
      title: "Lunar Spice: an interactive circuit simulator",
      description:
        "Draw a circuit and watch current flow, then run DC, AC and transient analyses. Opens Falstad circuits. Runs in your browser, on Linux and on macOS.",
      path: "/",
    }),
  component: LandingPage,
});

/** What the simulator does, in the order someone meets it. */
const FEATURES = [
  {
    title: "Watch it run",
    description:
      "A real-time simulation colors every wire by its voltage and moves dots with the current. Click switches, press buttons and add live scopes while it runs, from 1/1000× to 1000× real time.",
  },
  {
    title: "Analyses from Multisim",
    description:
      "DC operating point with every net voltage and part current, AC sweeps as Bode plots, and transients from rest or from the operating point.",
  },
  {
    title: "Real parts",
    description:
      "Pick a 1N4148, 2N3904, LM741, 7805 or NE555 and its datasheet values fill in, or paste a vendor SPICE .model card.",
  },
  {
    title: "Hear your circuit",
    description:
      "An electret microphone takes your computer's microphone as its input, and a speaker plays what reaches it.",
  },
  {
    title: "Opens Falstad circuits",
    description:
      "Circuits are saved in Falstad's text format, so Falstad exports open directly.",
  },
  {
    title: "Yours, in your browser",
    description:
      "No account. The web app saves circuits in your browser's storage, and the desktop app in a folder of plain text files.",
  },
] as const;

/** The page at `/`; the simulator itself lives at `/app`. */
function LandingPage() {
  return (
    <>
      <section className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 pt-24 pb-20 text-center">
        <h1 className="text-primary max-w-3xl text-5xl font-semibold tracking-tight text-balance">
          An interactive circuit simulator
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
          Draw a circuit and watch current flow through it, in the spirit of
          Falstad&apos;s. Then run the analyses you would reach for in Multisim.
        </p>
        <Button size="lg" nativeButton={false} render={<Link to="/app" />}>
          Open the simulator
          <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} />
        </Button>
      </section>
      <section
        aria-label="Features"
        className="mx-auto grid max-w-6xl gap-x-10 gap-y-12 px-6 pb-24 sm:grid-cols-2 lg:grid-cols-3"
      >
        {FEATURES.map((feature) => (
          <article key={feature.title} className="flex flex-col gap-2">
            <h2 className="text-foreground text-lg font-medium text-balance">
              {feature.title}
            </h2>
            <p className="text-muted-foreground text-pretty">
              {feature.description}
            </p>
          </article>
        ))}
      </section>
    </>
  );
}
