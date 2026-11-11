import { Separator } from "@lunar-spice/components/ui/separator";
import { Link } from "@tanstack/react-router";

/** The logo and what the app is. */
export function SiteFooter() {
  return (
    <>
      <Separator />
      <footer className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm">
        <Link
          to="/"
          className="font-logo text-primary text-xl hover:no-underline"
        >
          Lunar Spice
        </Link>
        <p>Open source under the AGPL. Also for Linux and macOS.</p>
      </footer>
    </>
  );
}
