import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const RESEND_REGISTRY_ENTRY: AppRegistryEntry = {
	blockKey: "deco-resend",
	module: () => import("./mod"),
	displayName: "Resend",
	category: "email",
	description: "Transactional email via Resend",
};
