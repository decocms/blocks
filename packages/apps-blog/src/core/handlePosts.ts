import type { BlogPost, SortBy } from "../types";

const VALID_SORT_ORDERS = ["asc", "desc"];

/**
 * Sort posts by the given criteria.
 * Skips view-based sorting (no Drizzle in this port).
 */
export const sortPosts = (blogPosts: BlogPost[], sortBy: SortBy): BlogPost[] => {
	const parts = sortBy.split("_");
	const sortMethod = (parts[0] in blogPosts[0] ? parts[0] : "date") as keyof BlogPost;
	const sortOrder = VALID_SORT_ORDERS.includes(parts[1]) ? parts[1] : "desc";

	return [...blogPosts].sort((a, b) => {
		if (!a[sortMethod] && !b[sortMethod]) return 0;
		if (!a[sortMethod]) return 1;
		if (!b[sortMethod]) return -1;

		const comparison =
			sortMethod === "date"
				? new Date(`${b.date}T00:00:00`).getTime() - new Date(`${a.date}T00:00:00`).getTime()
				: (a[sortMethod]?.toString().localeCompare(b[sortMethod]?.toString() ?? "") ?? 0);

		return sortOrder === "desc" ? comparison : -comparison;
	});
};

/** Filter posts by a single category slug. */
export const filterPostsByCategory = (posts: BlogPost[], slug?: string): BlogPost[] =>
	slug ? posts.filter(({ categories }) => categories?.find((c) => c.slug === slug)) : posts;

/** Filter posts whose slug is in the given list. */
export const filterPostsBySlugs = (posts: BlogPost[], postSlugs: string[]): BlogPost[] =>
	posts.filter(({ slug }) => postSlugs.includes(slug));

/** Filter posts matching a search term (title, excerpt, content). */
export const filterPostsByTerm = (posts: BlogPost[], term: string): BlogPost[] =>
	posts.filter(({ content, excerpt, title }) =>
		[content, excerpt, title].some((field) => field?.toLowerCase().includes(term.toLowerCase())),
	);

/** Filter posts whose categories overlap with the given slug array. */
export const filterRelatedPosts = (posts: BlogPost[], slugs: string[]): BlogPost[] =>
	posts.filter(({ categories }) => categories?.find((c) => slugs.includes(c.slug)));

/** Slice posts for pagination. */
export const slicePosts = (
	posts: BlogPost[],
	pageNumber: number,
	postsPerPage: number,
): BlogPost[] => {
	const startIndex = (pageNumber - 1) * postsPerPage;
	return posts.slice(startIndex, startIndex + postsPerPage);
};

/**
 * Combined filter & sort pipeline (no slice).
 */
export default function handlePosts(
	posts: BlogPost[],
	sortBy: SortBy,
	slug?: string | string[],
	postSlugs?: string[],
	term?: string,
	excludePostSlug?: string,
): BlogPost[] | null {
	let filtered: BlogPost[];

	if (typeof slug === "string") {
		filtered =
			postSlugs && postSlugs.length > 0
				? filterPostsBySlugs(posts, postSlugs)
				: filterPostsByCategory(posts, slug);
		if (term) filtered = filterPostsByTerm(filtered, term);
	} else if (Array.isArray(slug)) {
		filtered = filterRelatedPosts(posts, slug);
	} else {
		filtered = term ? filterPostsByTerm(posts, term) : posts;
	}

	if (excludePostSlug) {
		filtered = filtered.filter(({ slug: s }) => s !== excludePostSlug);
	}

	if (!filtered || filtered.length === 0) return null;

	return sortPosts(filtered, sortBy);
}
