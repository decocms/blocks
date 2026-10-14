import type { NextConfig } from "next";

/** A `next.config` header rule. */
export interface HeaderRule {
  source: string;
  has?: { type: string; key: string; value?: string }[];
  headers: { key: string; value: string }[];
}

export interface WithDecoOptions {
  /** v7's draft header rules (no-store, `Vary: Cookie`, noindex), before the site's own. Default `true`. */
  draftHeaders?: boolean;
  /** Studio's origins in `allowedDevOrigins`. Default `true`. */
  studioOrigins?: boolean;
}

/** The site's `next.config` with Deco's draft header rules and Studio's dev origins. */
export declare function withDeco<C extends NextConfig>(
  nextConfig?: C,
  options?: WithDecoOptions,
): C & NextConfig;

/** The header rules `withDeco` puts first: a `?__draft=` query, or the `__deco_draft` cookie. */
export declare const DECO_DRAFT_HEADERS: HeaderRule[];

/** `STUDIO_ORIGINS` of `@decocms/blocks` in `allowedDevOrigins` form. */
export declare const STUDIO_DEV_ORIGINS: string[];
