/**
 * Blog app singleton configuration.
 *
 * Holds what the Deno app carried on `AppContext` (`ctx.categorySlug`,
 * `ctx.pageSlug`, `ctx.canonicalBaseUrl`, `ctx.publisher`, `ctx.seo`). Loaders
 * and sections here take plain `(props, req?)`, so there is no `ctx` to read
 * from — this module is the replacement, matching `configureWebsite` /
 * `getWebsiteConfig` in `@decocms/apps-website`.
 *
 * Uses globalThis to survive Vite module duplication (optimized deps vs raw
 * source imports can create separate module instances).
 */

import type { Publisher } from "./types";

/**
 * SEO defaults the blog's SEO sections fold into their output.
 *
 * Structurally a subset of `@decocms/apps-website`'s `WebsiteConfig["seo"]`,
 * duplicated rather than imported so this stays a *type-only* relationship
 * across the two apps — an `apps-*` package may not depend on another at
 * runtime, and the website's own getter throws when unconfigured.
 */
export interface BlogSeoDefaults {
  titleTemplate?: string;
  descriptionTemplate?: string;
  [key: string]: unknown;
}

export interface BlogConfig {
  /**
   * Slug pattern of the category route, e.g. `/blog/:category`.
   */
  categorySlug?: string;
  /**
   * Slug pattern of the post route, e.g. `/blog/:category/:slug`.
   */
  pageSlug?: string;
  /**
   * Overrides the origin of the url/mainEntityOfPage emitted in the JSON-LD by
   * the SEO sections, which otherwise use the request host.
   */
  canonicalBaseUrl?: string;
  /**
   * Emitted as the publisher of the blog posts in the JSON-LD.
   */
  publisher?: Publisher;
  /**
   * Site-level SEO defaults (title/description templates and passthrough props).
   */
  seo?: BlogSeoDefaults;
}

const G = globalThis as unknown as { __decoBlogConfig?: BlogConfig };

export function configureBlog(config: BlogConfig): void {
  G.__decoBlogConfig = config;
}

/**
 * Returns the blog config, or `{}` when the app was never configured.
 *
 * Deliberately non-throwing, unlike `getWebsiteConfig()`: every field here is
 * optional and every consumer has a sensible default, so an unconfigured blog
 * should render with request-derived canonicals rather than 500 the page.
 */
export function getBlogConfig(): BlogConfig {
  return G.__decoBlogConfig ?? {};
}
