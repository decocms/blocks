import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/records", () => ({
	getRecordsByPath: vi.fn(),
}));

import { getRecordsByPath } from "../core/records";
import BlogPostItem from "../loaders/BlogPostItem";
import BlogPostPageLoader from "../loaders/BlogPostPage";
import BlogpostListing from "../loaders/BlogpostListing";
import BlogRelatedPostsLoader from "../loaders/BlogRelatedPosts";
import GetCategories from "../loaders/GetCategories";
import type { BlogPost, Category } from "../types";

const mockGetRecords = getRecordsByPath as ReturnType<typeof vi.fn>;

function makePost(overrides: Partial<BlogPost> = {}): BlogPost {
	return {
		title: "Test Post",
		slug: "test-post",
		date: "2024-06-01",
		excerpt: "A test post",
		content: "Full content here",
		categories: [{ name: "News", slug: "news" }],
		authors: [{ name: "Author", email: "a@b.com" }],
		...overrides,
	};
}

const samplePosts: BlogPost[] = [
	makePost({ slug: "post-a", title: "Alpha", date: "2024-01-01" }),
	makePost({ slug: "post-b", title: "Bravo", date: "2024-02-01" }),
	makePost({ slug: "post-c", title: "Charlie", date: "2024-03-01" }),
];

beforeEach(() => {
	vi.clearAllMocks();
	mockGetRecords.mockReturnValue(samplePosts);
});

// ---------------------------------------------------------------------------
// BlogpostListing
// ---------------------------------------------------------------------------
describe("BlogpostListing", () => {
	it("returns paginated listing with defaults (page=1, count=12, sortBy=date_desc)", () => {
		const result = BlogpostListing({});
		expect(result).not.toBeNull();
		expect(result!.posts).toHaveLength(3);
		expect(result!.pageInfo.currentPage).toBe(1);
		expect(result!.pageInfo.recordPerPage).toBe(12);
		// date_desc: most recent first
		expect(result!.posts[0].slug).toBe("post-c");
	});

	it("URL search params override props", () => {
		const req = new Request("http://localhost/blog?page=2&count=1");
		const result = BlogpostListing({}, req);
		expect(result).not.toBeNull();
		expect(result!.pageInfo.currentPage).toBe(2);
		expect(result!.posts).toHaveLength(1);
		expect(result!.posts[0].slug).toBe("post-b"); // second page of date_desc
	});

	it("computes nextPage / previousPage correctly", () => {
		const result = BlogpostListing({ count: 1, page: 2 });
		expect(result).not.toBeNull();
		expect(result!.pageInfo.nextPage).toContain("page=3");
		expect(result!.pageInfo.previousPage).toContain("page=1");
	});

	it("returns null when no posts match", () => {
		mockGetRecords.mockReturnValue([]);
		expect(BlogpostListing({})).toBeNull();
	});

	it("SEO canonical strips query params", () => {
		const req = new Request("http://localhost/blog?page=1&count=1");
		const result = BlogpostListing({}, req);
		expect(result).not.toBeNull();
		expect(result!.seo.canonical).toBe("http://localhost/blog");
	});
});

// ---------------------------------------------------------------------------
// BlogRelatedPosts
// ---------------------------------------------------------------------------
describe("BlogRelatedPostsLoader", () => {
	it("excludes current post via excludePostSlug", () => {
		const result = BlogRelatedPostsLoader({ excludePostSlug: "post-a" });
		expect(result).not.toBeNull();
		expect(result!.find((p) => p.slug === "post-a")).toBeUndefined();
	});

	it("returns BlogPost[] (not BlogPostListingPage)", () => {
		const result = BlogRelatedPostsLoader({});
		expect(Array.isArray(result)).toBe(true);
	});

	it("returns null when empty", () => {
		mockGetRecords.mockReturnValue([]);
		expect(BlogRelatedPostsLoader({})).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// BlogPostPage
// ---------------------------------------------------------------------------
describe("BlogPostPageLoader", () => {
	it("returns BlogPostPage with correct @type", () => {
		const result = BlogPostPageLoader({ slug: "post-a" });
		expect(result).not.toBeNull();
		expect(result!["@type"]).toBe("BlogPostPage");
		expect(result!.post.slug).toBe("post-a");
	});

	it("returns null when post not found", () => {
		expect(BlogPostPageLoader({ slug: "nonexistent" })).toBeNull();
	});

	it("SEO fields fall back to post fields", () => {
		mockGetRecords.mockReturnValue([
			makePost({
				slug: "no-seo",
				title: "Fallback Title",
				excerpt: "Fallback Desc",
				image: "img.png",
				seo: undefined,
			}),
		]);

		const result = BlogPostPageLoader({ slug: "no-seo" });
		expect(result).not.toBeNull();
		expect(result!.seo?.title).toBe("Fallback Title");
		expect(result!.seo?.description).toBe("Fallback Desc");
		expect(result!.seo?.image).toBe("img.png");
	});

	it("uses SEO fields when present", () => {
		mockGetRecords.mockReturnValue([
			makePost({
				slug: "has-seo",
				title: "Post Title",
				seo: { title: "SEO Title", description: "SEO Desc" },
			}),
		]);

		const result = BlogPostPageLoader({ slug: "has-seo" });
		expect(result!.seo?.title).toBe("SEO Title");
		expect(result!.seo?.description).toBe("SEO Desc");
	});
});

// ---------------------------------------------------------------------------
// GetCategories
// ---------------------------------------------------------------------------
describe("GetCategories", () => {
	const categories: Category[] = [
		{ name: "Beta", slug: "beta" },
		{ name: "Alpha", slug: "alpha" },
		{ name: "Charlie", slug: "charlie" },
	];

	beforeEach(() => {
		mockGetRecords.mockReturnValue([...categories]);
	});

	it("sorts by name (title_desc default)", () => {
		const result = GetCategories({});
		expect(result).not.toBeNull();
		expect(result!.map((c) => c.name)).toEqual(["Alpha", "Beta", "Charlie"]);
	});

	it("filters by slug when provided", () => {
		const result = GetCategories({ slug: "alpha" });
		expect(result).toHaveLength(1);
		expect(result![0].slug).toBe("alpha");
	});

	it("slices by count", () => {
		const result = GetCategories({ count: 2 });
		expect(result).toHaveLength(2);
	});

	it("returns null when no categories", () => {
		mockGetRecords.mockReturnValue([]);
		expect(GetCategories({})).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// BlogPostItem
// ---------------------------------------------------------------------------
describe("BlogPostItem", () => {
	it("returns post by slug", () => {
		const result = BlogPostItem({ slug: "post-b" });
		expect(result).not.toBeNull();
		expect(result!.slug).toBe("post-b");
	});

	it("returns null when no slug provided", () => {
		expect(BlogPostItem({ slug: "" })).toBeNull();
	});

	it("returns null when post not found", () => {
		expect(BlogPostItem({ slug: "nonexistent" })).toBeNull();
	});
});
