import { Button } from "@lunar-spice/components/ui/button";
import { Link } from "@tanstack/react-router";

/** The logo and the web app link. */
export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
      <Link
        to="/"
        className="font-logo text-primary text-3xl hover:no-underline"
      >
        Lunar Spice
      </Link>
      <Button nativeButton={false} render={<Link to="/app" />}>
        Open web app
      </Button>
    </header>
  );
}
