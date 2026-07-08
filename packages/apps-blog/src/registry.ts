import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const BLOG_REGISTRY_ENTRY: AppRegistryEntry = {
	blockKey: "deco-blog",
	module: () => import("./mod"),
	displayName: "Blog",
	category: "content",
	description: "Blog posts, categories, and authors from CMS collections",
};
