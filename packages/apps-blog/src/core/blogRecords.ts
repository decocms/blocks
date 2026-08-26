/**
 * Injectable persistence port for the blog's ratings, reviews and view counts.
 *
 * In `deco-cx/apps` these three features talk to the separate `records` app —
 * a Turso/libsql database driven through `drizzle-orm`, reached as
 * `await ctx.invoke.records.loaders.drizzle()`. Neither that app nor drizzle
 * exists in this monorepo, and adding them would make every site that installs
 * the blog app carry a database client it probably doesn't use.
 *
 * So the dependency is inverted, the same way `@decocms/blocks-admin` inverts
 * its KV dependency via `setFastDeployKVGetter`: this package declares the
 * operations it needs, and the site injects an implementation at boot. The port
 * is expressed as *domain* operations rather than as a query builder, so the
 * table and column names stay on the site's side of the boundary — which is
 * also why `db/schema.ts` is deliberately not ported.
 *
 * With no adapter registered every read degrades to empty and every write to
 * `null`, mirroring what the Deno app does when the `records` app isn't
 * installed. That's the common case: a blog with no comments or view counter
 * works untouched.
 */

import type { Person } from "@decocms/apps-commerce/types";
import type { Rating, Review, ViewFromDatabase } from "../types";

export interface ListReviewsOptions {
  slug: string;
  /**
   * `additionalType` values to exclude — the moderation states a site wants
   * kept out of the public list.
   */
  excludeAdditionalTypes?: string[];
  orderBy: "date_asc" | "date_desc";
}

export interface UpsertRatingInput {
  itemReviewed: string;
  author: Person;
  ratingValue: number;
  additionalType?: string;
}

export interface CreateReviewInput {
  itemReviewed?: string;
  author?: Person;
  reviewHeadline?: string;
  reviewBody?: string;
  additionalType?: string;
  isAnonymous?: boolean;
  datePublished: string;
  dateModified: string;
}

export interface UpdateReviewInput {
  reviewHeadline?: string;
  reviewBody?: string;
  additionalType?: string;
  dateModified: string;
}

/**
 * Every method is optional: a site that only wants view counts implements
 * `listPostViews`/`incrementPostView` and leaves the rest out.
 */
export interface BlogRecordsAdapter {
  listRatings?(slug: string): Promise<Rating[]>;
  /**
   * Creates the rating, or replaces the value of this author's existing rating
   * for the same item — one rating per author per post.
   */
  upsertRating?(input: UpsertRatingInput): Promise<Rating | null>;
  listReviews?(options: ListReviewsOptions): Promise<Review[]>;
  getReview?(id: string): Promise<Review | null>;
  createReview?(input: CreateReviewInput): Promise<Review | null>;
  updateReview?(id: string, patch: UpdateReviewInput): Promise<Review | null>;
  listPostViews?(): Promise<ViewFromDatabase[]>;
  /** Increments (or creates at 1) the view counter, returning the new total. */
  incrementPostView?(id: string): Promise<{ count: number }>;
}

const G = globalThis as unknown as { __decoBlogRecordsAdapter?: BlogRecordsAdapter };

/**
 * Registers the persistence backend for ratings, reviews and view counts.
 * Call once at boot, before any request is served.
 */
export function setBlogRecordsAdapter(adapter: BlogRecordsAdapter): void {
  G.__decoBlogRecordsAdapter = adapter;
}

/** The registered adapter, or `undefined` when the site never injected one. */
export function getBlogRecordsAdapter(): BlogRecordsAdapter | undefined {
  return G.__decoBlogRecordsAdapter;
}
