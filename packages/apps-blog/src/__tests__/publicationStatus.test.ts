/**
 * The reason this package was re-synced from `deco-cx/apps`.
 *
 * Scope: the read-time publication gate — `isPublishedStatus` / `isLivePost`,
 * `filterRoutablePosts`, and the fact that the gate runs *before* pagination so
 * `count` yields `count` renderable posts. Also covers the counterpart on the
 * detail loaders: a non-live post still renders (it is the CMS preview) but is
 * marked `noIndexing`.
 *
 * Deliberately not covered here: the strict-parsing edge cases of
 * `scheduledTime` (see `date.test.ts`) and anything requiring a records
 * adapter (ratings/reviews/views).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/records", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/records")>();
  return { ...actual, getRecordsByPath: vi.fn() };
});

import handlePosts, { filterRoutablePosts } from "../core/handlePosts";
import { getRecordsByPath } from "../core/records";
import BlogPostItem from "../loaders/BlogPostItem";
import BlogPostPageLoader from "../loaders/BlogPostPage";
import BlogpostListing from "../loaders/BlogpostListing";
import type { BlogPost, PostStatus } from "../types";
import { isLivePost, isPublishedStatus } from "../types";

const mockGetRecords = getRecordsByPath as ReturnType<typeof vi.fn>;

const post = (overrides: Partial<BlogPost> = {}): BlogPost => ({
  title: "Post",
  slug: "post",
  date: "2024-06-01",
  excerpt: "excerpt",
  ...overrides,
});

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("isPublishedStatus", () => {
  it("treats an absent status as published — legacy records predate the field", () => {
    expect(isPublishedStatus(undefined)).toBe(true);
    expect(isPublishedStatus("")).toBe(true);
  });

  it("accepts only an explicit `published`", () => {
    expect(isPublishedStatus("published")).toBe(true);
    for (const status of ["draft", "scheduled", "archived", "generating", "awaiting_review"]) {
      expect(isPublishedStatus(status)).toBe(false);
    }
  });

  it("fails closed on a status this version does not know", () => {
    expect(isPublishedStatus("some_future_state")).toBe(false);
  });
});

describe("isLivePost", () => {
  it("hides every non-published, non-scheduled status", () => {
    const hidden: PostStatus[] = ["draft", "archived", "generating", "awaiting_review"];
    for (const status of hidden) {
      expect(isLivePost({ status })).toBe(false);
    }
  });

  it("hides a scheduled post whose instant has not arrived", () => {
    expect(isLivePost({ status: "scheduled", scheduledDatetime: iso(HOUR) })).toBe(false);
  });

  it("shows a scheduled post whose instant has passed", () => {
    expect(isLivePost({ status: "scheduled", scheduledDatetime: iso(-HOUR) })).toBe(true);
  });

  it("hides a scheduled post with a missing or unreadable instant", () => {
    expect(isLivePost({ status: "scheduled" })).toBe(false);
    // Lenient `Date` would read this as the year 2000, i.e. already live.
    expect(isLivePost({ status: "scheduled", scheduledDatetime: "0" })).toBe(false);
    // Calendar overflow must be rejected, not rolled forward to March 3rd.
    expect(isLivePost({ status: "scheduled", scheduledDatetime: "2020-02-31" })).toBe(false);
  });

  it("honours the epoch as a real instant", () => {
    expect(isLivePost({ status: "scheduled", scheduledDatetime: "1970-01-01T00:00:00Z" })).toBe(
      true,
    );
  });
});

describe("filterRoutablePosts", () => {
  it("drops posts with no usable slug — they have no route to link to", () => {
    const posts = [
      post({ slug: "ok" }),
      post({ slug: "" }),
      post({ slug: "   " }),
      post({ slug: undefined as unknown as string }),
      post({ slug: 42 as unknown as string }),
    ];
    expect(filterRoutablePosts(posts).map((p) => p.slug)).toEqual(["ok"]);
  });
});

describe("listing pagination applies the gate before slicing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mixed = [
    post({ slug: "live-1", date: "2024-05-01" }),
    post({ slug: "draft-1", date: "2024-04-01", status: "draft" }),
    post({ slug: "generating-1", date: "2024-03-01", status: "generating" }),
    post({
      slug: "future-1",
      date: "2024-02-01",
      status: "scheduled",
      scheduledDatetime: iso(HOUR),
    }),
    post({
      slug: "past-1",
      date: "2024-01-01",
      status: "scheduled",
      scheduledDatetime: iso(-HOUR),
    }),
  ];

  it("handlePosts keeps only live posts", async () => {
    const result = await handlePosts(mixed, "date_desc");
    expect(result?.map((p) => p.slug)).toEqual(["live-1", "past-1"]);
  });

  it("count: 2 yields 2 renderable posts, not 2 records minus the hidden ones", async () => {
    mockGetRecords.mockReturnValue(mixed);
    const result = await BlogpostListing({ count: 2 });
    expect(result).not.toBeNull();
    // Without the gate running first, the page-1 slice would have been
    // [live-1, draft-1] and rendered a single visible card.
    expect(result?.posts.map((p) => p.slug)).toEqual(["live-1", "past-1"]);
  });

  it("returns null when every record is gated out", async () => {
    mockGetRecords.mockReturnValue([post({ slug: "d", status: "draft" })]);
    expect(await BlogpostListing({})).toBeNull();
  });
});

describe("detail loaders serve non-live posts as previews, unindexed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("BlogPostPage marks a draft noIndexing but still renders it", () => {
    mockGetRecords.mockReturnValue([post({ slug: "d", status: "draft" })]);
    const result = BlogPostPageLoader({ slug: "d" });
    expect(result?.post.slug).toBe("d");
    expect(result?.seo?.noIndexing).toBe(true);
  });

  it("BlogPostPage leaves a live post indexable", () => {
    mockGetRecords.mockReturnValue([post({ slug: "p", status: "published" })]);
    expect(BlogPostPageLoader({ slug: "p" })?.seo?.noIndexing).toBe(false);
  });

  it("BlogPostItem stamps noIndexing without discarding the post's own seo", () => {
    mockGetRecords.mockReturnValue([post({ slug: "d", status: "draft", seo: { title: "Kept" } })]);
    const result = BlogPostItem({ slug: "d" });
    expect(result?.seo).toEqual({ title: "Kept", noIndexing: true });
  });

  it("BlogPostItem returns a live post untouched", () => {
    const live = post({ slug: "p" });
    mockGetRecords.mockReturnValue([live]);
    expect(BlogPostItem({ slug: "p" })).toBe(live);
  });
});
