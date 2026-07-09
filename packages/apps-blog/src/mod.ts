/**
 * Blog app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern.
 * Provides blog post, category, and author loaders for the site.
 */

import type {
	AppDefinition,
	ResolveSecretFn,
} from "@decocms/apps-commerce/app-types";
import manifest from "./manifest.gen";

// -------------------------------------------------------------------------
// CMS Props
// -------------------------------------------------------------------------

/** @title Deco Blog */
export interface Props {
	/**
	 * @title Page Slug
	 * @description The slug of the BlogPostPage to embed. Use :category and :slug.
	 */
	pageSlug?: string;
}

export type BlogState = Props;

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure the Blog app from CMS block data.
 * Always returns an AppDefinition (no required fields).
 */
export async function configure(
	// biome-ignore lint/suspicious/noExplicitAny: block data comes from CMS with no fixed schema
	_block: any,
	_resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<BlogState>> {
	return {
		name: "blog",
		manifest,
		state: { pageSlug: _block?.pageSlug },
	};
}

/** Placeholder preview for CMS editor. */
export const preview = undefined;

/** Default export for schema generation and Deno-style app bridges. */
export default function Blog(state: Props) {
	return { state };
}
