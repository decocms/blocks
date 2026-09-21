import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const WAKE_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-wake",
  module: () => import("./mod"),
  displayName: "Wake",
  category: "commerce",
  description: "Wake Commerce (Storefront API) integration",
};
