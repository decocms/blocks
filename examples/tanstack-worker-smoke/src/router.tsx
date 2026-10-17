import { createDecoRouter } from "@decocms/tanstack/router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createDecoRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
