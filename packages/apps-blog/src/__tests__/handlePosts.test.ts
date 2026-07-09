import { describe, expect, it } from "vitest";
import handlePosts, {
	filterPostsByCategory,
	filterPostsBySlugs,
	filterPostsByTerm,
	filterRelatedPosts,
	slicePosts,
	sortPosts,
} from "../core/handlePosts";
import type { BlogPost, SortBy } from "../types";

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

// ---------------------------------------------------------------------------
// sortPosts
// ---------------------------------------------------------------------------
describe("sortPosts", () => {
	const posts = [
		makePost({ title: "Alpha", slug: "a", date: "2024-01-01" }),
		makePost({ title: "Charlie", slug: "c", date: "2024-03-01" }),
		makePost({ title: "Bravo", slug: "b", date: "2024-02-01" }),
	];

	it("sorts date_desc — most recent first", () => {
		const sorted = sortPosts(posts, "date_desc");
		expect(sorted.map((p) => p.slug)).toEqual(["c", "b", "a"]);
	});

	it("sorts date_asc — oldest first", () => {
		const sorted = sortPosts(posts, "date_asc");
		expect(sorted.map((p) => p.slug)).toEqual(["a", "b", "c"]);
	});

	it("sorts title_asc", () => {
		const sorted = sortPosts(posts, "title_asc");
		// localeCompare(a,b) is negated for asc → Z-A
		expect(sorted.map((p) => p.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
	});

	it("sorts title_desc", () => {
		const sorted = sortPosts(posts, "title_desc");
		// localeCompare(a,b) kept as-is for desc → A-Z
		expect(sorted.map((p) => p.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
	});

	it("falls back to date for invalid sort field", () => {
		const sorted = sortPosts(posts, "invalid_desc" as SortBy);
		expect(sorted.map((p) => p.slug)).toEqual(["c", "b", "a"]);
	});

	it("falls back to desc for invalid sort order", () => {
		const sorted = sortPosts(posts, "date_wrong" as SortBy);
		expect(sorted.map((p) => p.slug)).toEqual(["c", "b", "a"]);
	});

	it("sorts posts with missing date to end", () => {
		const withMissing = [
			makePost({ slug: "no-date", date: undefined as unknown as string }),
			makePost({ slug: "has-date", date: "2024-06-01" }),
		];
		const sorted = sortPosts(withMissing, "date_desc");
		expect(sorted[0].slug).toBe("has-date");
		expect(sorted[1].slug).toBe("no-date");
	});

	it("throws on empty array (accesses blogPosts[0])", () => {
		expect(() => sortPosts([], "date_desc")).toThrow();
	});

	it("does not mutate original array", () => {
		const original = [...posts];
		sortPosts(posts, "date_asc");
		expect(posts).toEqual(original);
	});
});

// ---------------------------------------------------------------------------
// filterPostsByCategory
// ---------------------------------------------------------------------------
describe("filterPostsByCategory", () => {
	const posts = [
		makePost({ slug: "a", categories: [{ name: "News", slug: "news" }] }),
		makePost({
			slug: "b",
			categories: [
				{ name: "News", slug: "news" },
				{ name: "Tech", slug: "tech" },
			],
		}),
		makePost({ slug: "c", categories: [{ name: "Tech", slug: "tech" }] }),
	];

	it("returns all posts when no slug provided", () => {
		expect(filterPostsByCategory(posts)).toHaveLength(3);
	});

	it("filters by matching slug", () => {
		const result = filterPostsByCategory(posts, "tech");
		expect(result.map((p) => p.slug)).toEqual(["b", "c"]);
	});

	it("returns empty when no match", () => {
		expect(filterPostsByCategory(posts, "sports")).toEqual([]);
	});

	it("excludes posts with no categories", () => {
		const withNone = [...posts, makePost({ slug: "d", categories: undefined })];
		expect(filterPostsByCategory(withNone, "news").map((p) => p.slug)).toEqual(["a", "b"]);
	});

	it("includes post when one of multiple categories matches", () => {
		const result = filterPostsByCategory(posts, "tech");
		expect(result.find((p) => p.slug === "b")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// filterPostsBySlugs
// ---------------------------------------------------------------------------
describe("filterPostsBySlugs", () => {
	const posts = [makePost({ slug: "a" }), makePost({ slug: "b" }), makePost({ slug: "c" })];

	it("filters to only matching slugs", () => {
		expect(filterPostsBySlugs(posts, ["a", "c"]).map((p) => p.slug)).toEqual(["a", "c"]);
	});

	it("returns empty for empty slugs array", () => {
		expect(filterPostsBySlugs(posts, [])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// filterPostsByTerm
// ---------------------------------------------------------------------------
describe("filterPostsByTerm", () => {
	const posts = [
		makePost({ slug: "a", title: "Hello World", excerpt: "intro", content: "body" }),
		makePost({ slug: "b", title: "Goodbye", excerpt: "farewell world", content: "end" }),
		makePost({ slug: "c", title: "Nothing", excerpt: "nope", content: "empty" }),
	];

	it("matches in title", () => {
		expect(filterPostsByTerm(posts, "Hello").map((p) => p.slug)).toEqual(["a"]);
	});

	it("matches in excerpt", () => {
		expect(filterPostsByTerm(posts, "farewell").map((p) => p.slug)).toEqual(["b"]);
	});

	it("matches in content", () => {
		expect(filterPostsByTerm(posts, "empty").map((p) => p.slug)).toEqual(["c"]);
	});

	it("is case-insensitive", () => {
		expect(filterPostsByTerm(posts, "hELLo")).toHaveLength(1);
	});

	it("returns empty when no match", () => {
		expect(filterPostsByTerm(posts, "zzz")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// filterRelatedPosts
// ---------------------------------------------------------------------------
describe("filterRelatedPosts", () => {
	const posts = [
		makePost({ slug: "a", categories: [{ name: "News", slug: "news" }] }),
		makePost({ slug: "b", categories: [{ name: "Tech", slug: "tech" }] }),
		makePost({ slug: "c", categories: undefined }),
	];

	it("includes post with category overlap", () => {
		expect(filterRelatedPosts(posts, ["news"]).map((p) => p.slug)).toEqual(["a"]);
	});

	it("excludes post with no overlap", () => {
		expect(filterRelatedPosts(posts, ["sports"])).toEqual([]);
	});

	it("excludes post with no categories", () => {
		const result = filterRelatedPosts(posts, ["news"]);
		expect(result.find((p) => p.slug === "c")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// slicePosts
// ---------------------------------------------------------------------------
describe("slicePosts", () => {
	const posts = Array.from({ length: 5 }, (_, i) => makePost({ slug: `p${i + 1}` }));

	it("page 1 returns first N", () => {
		expect(slicePosts(posts, 1, 2).map((p) => p.slug)).toEqual(["p1", "p2"]);
	});

	it("page 2 returns next N", () => {
		expect(slicePosts(posts, 2, 2).map((p) => p.slug)).toEqual(["p3", "p4"]);
	});

	it("last page with fewer items", () => {
		expect(slicePosts(posts, 3, 2).map((p) => p.slug)).toEqual(["p5"]);
	});

	it("page beyond total returns empty", () => {
		expect(slicePosts(posts, 10, 2)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// handlePosts (composition pipeline)
// ---------------------------------------------------------------------------
describe("handlePosts", () => {
	const posts = [
		makePost({
			slug: "a",
			title: "Alpha",
			date: "2024-01-01",
			categories: [{ name: "News", slug: "news" }],
		}),
		makePost({
			slug: "b",
			title: "Bravo",
			date: "2024-02-01",
			categories: [{ name: "Tech", slug: "tech" }],
		}),
		makePost({
			slug: "c",
			title: "Charlie",
			date: "2024-03-01",
			categories: [
				{ name: "News", slug: "news" },
				{ name: "Tech", slug: "tech" },
			],
		}),
	];

	it("slug string + postSlugs — uses slug filtering", () => {
		const result = handlePosts(posts, "date_desc", "news", ["a", "c"]);
		// sorted by date_desc: c (March) before a (Jan)
		expect(result?.map((p) => p.slug)).toEqual(["c", "a"]);
	});

	it("slug string + term — chains category + term filters", () => {
		const result = handlePosts(posts, "date_desc", "news", undefined, "Alpha");
		expect(result?.map((p) => p.slug)).toEqual(["a"]);
	});

	it("slug as string[] — triggers related posts path", () => {
		const result = handlePosts(posts, "date_desc", ["tech"]);
		expect(result?.map((p) => p.slug)).toEqual(["c", "b"]);
	});

	it("no slug + term — term-only filtering", () => {
		const result = handlePosts(posts, "date_asc", undefined, undefined, "Bravo");
		expect(result).toHaveLength(1);
		expect(result![0].slug).toBe("b");
	});

	it("excludePostSlug removes matching post", () => {
		const result = handlePosts(posts, "date_desc", undefined, undefined, undefined, "b");
		expect(result?.find((p) => p.slug === "b")).toBeUndefined();
	});

	it("returns null when result is empty", () => {
		expect(handlePosts(posts, "date_desc", "nonexistent")).toBeNull();
	});

	it("returns all posts sorted when no filters given", () => {
		const result = handlePosts(posts, "date_desc");
		expect(result).toHaveLength(3);
		expect(result![0].slug).toBe("c");
	});
});
