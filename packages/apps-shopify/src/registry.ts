import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const SHOPIFY_REGISTRY_ENTRY: AppRegistryEntry = {
	blockKey: "deco-shopify",
	module: () => import("./mod"),
	displayName: "Shopify",
	category: "commerce",
	description: "Shopify Storefront API commerce integration",
};
