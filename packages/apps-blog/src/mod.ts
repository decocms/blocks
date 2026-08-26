/**
 * Blog app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern.
 * Provides blog post, category, and author loaders, the SEO sections, and the
 * post-content section blocks for the site.
 */

import type { AppDefinition, AppHandler, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import submitRating from "./actions/submitRating";
import submitReview from "./actions/submitReview";
import submitView from "./actions/submitView";
import { type BlogConfig, type BlogSeoDefaults, configureBlog } from "./client";
import manifest from "./manifest.gen";
import type { Publisher } from "./types";

// -------------------------------------------------------------------------
// CMS Props
// -------------------------------------------------------------------------

/** @title Deco Blog */
export interface Props {
  /**
   * @title Category Slug
   * @description The slug of the Categories of the blogposts. Use :category
   * @example /blog/:category
   */
  categorySlug?: string;
  /**
   * @title Page Slug
   * @description The slug of the BlogPostPage to embed. Use :category and :slug.
   * @example /blog/:category/:slug
   */
  pageSlug?: string;
  /**
   * @title Canonical Base URL
   * @description Overrides the origin of the url/mainEntityOfPage emitted in the JSON-LD by the SEO sections, which otherwise use the request host.
   * @example https://www.mysite.com
   */
  canonicalBaseUrl?: string;
  /**
   * @title Publisher
   * @description Emitted as the publisher of the blog posts in the JSON-LD.
   */
  publisher?: Publisher;
  /**
   * @title SEO defaults
   * @description Title/description templates folded into the output of the blog's SEO sections.
   */
  seo?: BlogSeoDefaults;
}

export type BlogState = Props;

/**
 * Action entrypoints, exposed under both key forms the resolver may use.
 * Mirrors `@decocms/apps-resend`'s `handlers` map.
 */
export const handlers: Record<string, AppHandler> = {
  "blog/actions/submitRating": (props) => submitRating(props),
  "blog/actions/submitRating.ts": (props) => submitRating(props),
  "blog/actions/submitReview": (props) => submitReview(props),
  "blog/actions/submitReview.ts": (props) => submitReview(props),
  "blog/actions/submitView": (props) => submitView(props),
  "blog/actions/submitView.ts": (props) => submitView(props),
};

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure the Blog app from CMS block data.
 * Always returns an AppDefinition — every field is optional, so a blog with no
 * block configured still resolves and renders.
 */
export async function configure(
  block: any,
  _resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<BlogState>> {
  const config: BlogConfig = {
    categorySlug: block?.categorySlug,
    pageSlug: block?.pageSlug,
    canonicalBaseUrl: block?.canonicalBaseUrl,
    publisher: block?.publisher,
    seo: block?.seo,
  };

  // Bridge: the loaders and sections read this singleton in place of the Deno
  // app's `ctx`, which has no equivalent here.
  configureBlog(config);

  return {
    name: "blog",
    manifest,
    state: config,
  };
}

/** Placeholder preview for CMS editor. */
export const preview = undefined;

/** Default export for schema generation and Deno-style app bridges. */
export default function Blog(state: Props) {
  return { state };
}
