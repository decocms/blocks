/**
 * Scope: the injectable persistence port that replaces the Deno app's `records`
 * dependency — that reads/writes route through the registered adapter, and that
 * everything degrades safely when a site registers none (or a partial one).
 *
 * The degrade path is the important half: it is the default for any site that
 * installs the blog app without a database, so a regression here breaks blogs
 * that never asked for ratings at all.
 *
 * Deliberately not covered: any real database. The adapter boundary exists
 * precisely so this package never needs one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import submitRating from "../actions/submitRating";
import submitReview from "../actions/submitReview";
import submitView from "../actions/submitView";
import {
  type BlogRecordsAdapter,
  type CreateReviewInput,
  type ListReviewsOptions,
  setBlogRecordsAdapter,
  type UpdateReviewInput,
} from "../core/blogRecords";
import { sortPosts } from "../core/handlePosts";
import { getRatings, getReviews, getReviewsBySlug } from "../core/records";
import type { BlogPost, Review } from "../types";

const G = globalThis as unknown as { __decoBlogRecordsAdapter?: BlogRecordsAdapter };

const post = (slug: string, date = "2024-01-01"): BlogPost => ({
  title: slug,
  slug,
  date,
  excerpt: "",
});

const clearAdapter = () => {
  delete G.__decoBlogRecordsAdapter;
};

beforeEach(clearAdapter);
afterEach(clearAdapter);

describe("with no adapter registered", () => {
  it("getRatings yields a zeroed aggregate rather than throwing", async () => {
    const result = await getRatings({ post: post("a") });
    expect(result.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingCount: 0,
      ratingValue: 0,
      bestRating: 5,
      worstRating: 1,
    });
    expect(result.contentRating).toEqual([]);
  });

  it("getReviews yields an empty list and a zero count", async () => {
    const result = await getReviews({ post: post("a") });
    expect(result.review).toEqual([]);
    expect(result.aggregateRating?.reviewCount).toBe(0);
  });

  it("write actions report failure instead of throwing", async () => {
    expect(
      await submitRating({ itemReviewed: "a", author: { email: "a@b.com" }, ratingValue: 5 }),
    ).toBeNull();
    expect(await submitReview({ action: "create", reviewBody: "hi" })).toBeNull();
    // A view beacon gets a well-formed response, not an error.
    expect(await submitView({ id: "a" })).toEqual({ count: 0 });
  });

  it("view sorting falls back to date order instead of throwing", async () => {
    // Upstream threw "Deco Records not installed!" here; degrading is the
    // deliberate difference — see this package's README.
    const posts = [post("old", "2024-01-01"), post("new", "2024-03-01")];
    const sorted = await sortPosts(posts, "view_desc");
    expect(sorted.map((p) => p.slug)).toEqual(["new", "old"]);
  });
});

describe("with an adapter registered", () => {
  it("getRatings aggregates the adapter's rows and stamps the scale", async () => {
    setBlogRecordsAdapter({
      listRatings: async () => [
        { "@type": "Rating", ratingValue: 5 },
        { "@type": "Rating", ratingValue: 3 },
      ],
    });

    const result = await getRatings({ post: post("a") });
    expect(result.aggregateRating).toMatchObject({ ratingCount: 2, ratingValue: 4 });
    // bestRating/worstRating are a property of this app's UI, not of the row.
    expect(result.contentRating?.[0]).toMatchObject({ bestRating: 5, worstRating: 1 });
  });

  it("getRatings honours ignoreRatings when computing the aggregate", async () => {
    setBlogRecordsAdapter({
      listRatings: async () => [
        { "@type": "Rating", ratingValue: 5 },
        { "@type": "Rating", ratingValue: 1, additionalType: "spam" },
      ],
    });

    const result = await getRatings({
      post: post("a"),
      ignoreRatings: { active: true, markedAs: ["spam"] },
    });
    expect(result.aggregateRating).toMatchObject({ ratingCount: 1, ratingValue: 5 });
  });

  it("onlyAggregate omits the per-rating list", async () => {
    setBlogRecordsAdapter({ listRatings: async () => [{ "@type": "Rating", ratingValue: 4 }] });
    const result = await getRatings({ post: post("a"), onlyAggregate: true });
    expect(result.contentRating).toBeUndefined();
    expect(result.aggregateRating?.ratingValue).toBe(4);
  });

  it("translates an active ignoreReviews into excludeAdditionalTypes", async () => {
    const listReviews = vi.fn(async (_opts: ListReviewsOptions): Promise<Review[]> => []);
    setBlogRecordsAdapter({ listReviews });

    await getReviewsBySlug({
      slug: "a",
      ignoreReviews: { active: true, markedAs: ["pending"] },
      orderBy: "date_asc",
    });
    expect(listReviews).toHaveBeenCalledWith({
      slug: "a",
      excludeAdditionalTypes: ["pending"],
      orderBy: "date_asc",
    });
  });

  it("leaves excludeAdditionalTypes unset when ignoreReviews is inactive or empty", async () => {
    const listReviews = vi.fn(async (_opts: ListReviewsOptions): Promise<Review[]> => []);
    setBlogRecordsAdapter({ listReviews });

    await getReviewsBySlug({ slug: "a", ignoreReviews: { active: false, markedAs: ["x"] } });
    await getReviewsBySlug({ slug: "a", ignoreReviews: { active: true, markedAs: [] } });
    for (const call of listReviews.mock.calls) {
      expect(call[0]).toMatchObject({ excludeAdditionalTypes: undefined });
    }
  });

  it("defaults review ordering to date_desc", async () => {
    const listReviews = vi.fn(async (_opts: ListReviewsOptions): Promise<Review[]> => []);
    setBlogRecordsAdapter({ listReviews });
    await getReviewsBySlug({ slug: "a" });
    expect(listReviews).toHaveBeenCalledWith(expect.objectContaining({ orderBy: "date_desc" }));
  });

  it("stamps view counts onto posts and sorts by them (inverted, per upstream)", async () => {
    setBlogRecordsAdapter({
      listPostViews: async () => [
        { id: "low", userInteractionCount: 2 },
        { id: "high", userInteractionCount: 90 },
      ],
    });

    const posts = [post("low"), post("high")];
    // `view_desc` yields least-viewed-first: upstream's comparator is `a - b`
    // under `desc`. Preserved deliberately — see the comment in handlePosts.ts.
    expect((await sortPosts(posts, "view_desc")).map((p) => p.slug)).toEqual(["low", "high"]);
    expect((await sortPosts(posts, "view_asc")).map((p) => p.slug)).toEqual(["high", "low"]);
    // Either way the counts are attached to the posts, which is what the SEO
    // JSON-LD reads as interactionStatistic.
    expect(posts.find((p) => p.slug === "high")?.interactionStatistic).toEqual({
      "@type": "InteractionCounter",
      userInteractionCount: 90,
    });
  });

  it("increments a view through the adapter", async () => {
    setBlogRecordsAdapter({ incrementPostView: async () => ({ count: 7 }) });
    expect(await submitView({ id: "a" })).toEqual({ count: 7 });
  });

  it("swallows an adapter failure on read and returns the empty shape", async () => {
    setBlogRecordsAdapter({
      listRatings: async () => {
        throw new Error("db down");
      },
    });
    const result = await getRatings({ post: post("a") });
    expect(result.contentRating).toEqual([]);
    expect(result.aggregateRating?.ratingCount).toBe(0);
  });

  it("swallows an adapter failure on write and reports it as null", async () => {
    setBlogRecordsAdapter({
      upsertRating: async () => {
        throw new Error("db down");
      },
    });
    expect(
      await submitRating({ itemReviewed: "a", author: { email: "a@b.com" }, ratingValue: 5 }),
    ).toBeNull();
  });

  it("refuses to update a review that does not exist", async () => {
    setBlogRecordsAdapter({
      getReview: async () => null,
      updateReview: async () => null,
    });
    expect(await submitReview({ action: "update", id: "missing", reviewBody: "x" })).toBeNull();
  });

  it("patches an update over the stored review, preserving untouched fields", async () => {
    const updateReview = vi.fn(
      async (_id: string, _patch: UpdateReviewInput): Promise<Review | null> => null,
    );
    setBlogRecordsAdapter({
      getReview: async () => ({
        "@type": "Review",
        id: "r1",
        itemReviewed: "a",
        reviewBody: "old body",
        reviewHeadline: "old headline",
        additionalType: "approved",
        datePublished: "2024-01-01T00:00:00.000Z",
        author: { name: "Ana" },
      }),
      updateReview,
    });

    const result = await submitReview({ action: "update", id: "r1", reviewBody: "new body" });

    // Only the sent field changes; headline/status/author/datePublished survive.
    expect(updateReview).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({
        reviewBody: "new body",
        reviewHeadline: "old headline",
        additionalType: "approved",
      }),
    );
    expect(result).toMatchObject({
      "@type": "Review",
      id: "r1",
      reviewBody: "new body",
      datePublished: "2024-01-01T00:00:00.000Z",
      author: { name: "Ana" },
    });
  });

  it("creates a review with both timestamps set", async () => {
    const createReview = vi.fn(async (_input: CreateReviewInput): Promise<Review | null> => null);
    setBlogRecordsAdapter({ createReview });

    const result = await submitReview({
      action: "create",
      itemReviewed: "a",
      reviewBody: "great",
    });

    const arg = createReview.mock.calls[0][0];
    expect(arg.datePublished).toBe(arg.dateModified);
    expect(result).toMatchObject({ "@type": "Review", reviewBody: "great" });
  });

  it("returns null when the adapter implements only part of the port", async () => {
    // A site that wants view counts and nothing else.
    setBlogRecordsAdapter({ incrementPostView: async () => ({ count: 1 }) });
    expect(await submitReview({ action: "create", reviewBody: "x" })).toBeNull();
    expect(
      await submitRating({ itemReviewed: "a", author: { email: "a@b.com" }, ratingValue: 5 }),
    ).toBeNull();
  });
});
