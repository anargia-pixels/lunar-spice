import { createFileRoute } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense } from "react";

import { pageHead } from "@/lib/seo";

// The editor reads browser storage while its modules load, so it never renders
// on the server, and the server build drops the import.
const Editor = lazy<ComponentType>(() =>
  import.meta.env.SSR
    ? Promise.resolve({ default: () => null })
    : import("./editor"),
);

export const Route = createFileRoute("/app/")({
  head: () =>
    pageHead(
      "Lunar Spice web app",
      "Draw a circuit and simulate it in your browser. Circuits stay in your browser's storage.",
    ),
  ssr: false,
  component: () => (
    <Suspense>
      <Editor />
    </Suspense>
  ),
});
