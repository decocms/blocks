import { DecoDocument } from "@decocms/tanstack/react";
import { createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Deco example" },
    ],
  }),
  component: () => <DecoDocument site="tanstack-worker-smoke" />,
});
