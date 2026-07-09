import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const VTEX_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-vtex",
  module: () => import("./mod"),
  displayName: "VTEX",
  category: "commerce",
  description: "VTEX IO commerce integration",
};
