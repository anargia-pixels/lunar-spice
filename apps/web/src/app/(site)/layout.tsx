import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export const Route = createFileRoute("/(site)")({
  component: SiteLayout,
});

/** The landing page's skeleton, always in the dark theme. */
function SiteLayout() {
  return (
    <div className="dark bg-sidebar text-foreground flex min-h-full flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
