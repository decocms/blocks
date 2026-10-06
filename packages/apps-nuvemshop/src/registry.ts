import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const NUVEMSHOP_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-nuvemshop",
  module: () => import("./mod"),
  displayName: "Nuvemshop",
  category: "commerce",
  description: "Nuvemshop (Tiendanube) Storefront API commerce integration",
};
