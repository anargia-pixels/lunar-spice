import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SITE_URL } from "@/lib/seo";

import appCss from "@/app/globals.css?url";

/** The 1200×630 social preview image every page shares. */
const OG_IMAGE_URL = `${SITE_URL}/landing/og.jpg`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Lunar Spice" },
      { name: "darkreader-lock" }, // Keeps Dark Reader off; the app has a dark theme.
      { name: "theme-color", content: "#181825" }, // Catppuccin Mocha mantle.
      { property: "og:site_name", content: "Lunar Spice" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: OG_IMAGE_URL },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: "A common-emitter amplifier simulated in Lunar Spice",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: OG_IMAGE_URL },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/x-icon", href: "/icons/icon.ico" },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/icons/32x32.png",
      },
      { rel: "apple-touch-icon", sizes: "256x256", href: "/icons/256x256.png" },
    ],
  }),
  shellComponent: RootDocument,
});

/** The HTML document every page renders inside. */
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
