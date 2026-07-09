import handlePosts, { slicePosts } from "../core/handlePosts";
import { getRecordsByPath } from "../core/records";
import type { BlogPost, SortBy } from "../types";

const COLLECTION_PATH = "collections/blog/posts";
const ACCESSOR = "post";

export interface Props {
	/**
	 * @title Items per page
	 * @description Number of posts per page to display.
	 */
	count?: number;
	/**
	 * @title Page query parameter
	 * @description The current page number. Defaults to 1.
	 */
	page?: number;
	/**
	 * @title Category Slug
	 * @description Filter by a specific category slug.
	 */
	slug?: string | string[];
	/**
	 * @title Page sorting parameter
	 * @description The sorting option. Default is "date_desc"
	 */
	sortBy?: SortBy;
	/**
	 * @description Overrides the query term at url
	 */
	query?: string;
	/**
	 * @title Exclude Post Slug
	 * @description Excludes a post slug from the list
	 */
	excludePostSlug?: string;
}

export type BlogRelatedPosts = BlogPost[] | null;

/**
 * @title BlogRelatedPosts
 * @description Retrieves a list of blog related posts.
 */
export default function BlogRelatedPostsLoader(
	props: Props & { __pageUrl?: string },
	req?: Request,
): BlogRelatedPosts {
	const { page, count, slug, sortBy, query, excludePostSlug } = props;
	const rawUrl = req?.url ?? props.__pageUrl ?? "http://localhost/";
	const url = new URL(rawUrl);
	const postsPerPage = Number(count ?? url.searchParams.get("count") ?? 12);
	const pageNumber = Number(page ?? url.searchParams.get("page") ?? 1);
	const pageSort = sortBy ?? (url.searchParams.get("sortBy") as SortBy) ?? "date_desc";
	const term = query ?? url.searchParams.get("q") ?? undefined;

	const posts = getRecordsByPath<BlogPost>(COLLECTION_PATH, ACCESSOR);

	const handledPosts = handlePosts(posts, pageSort, slug, undefined, term, excludePostSlug);

	if (!handledPosts) return null;

	const slicedPosts = slicePosts(handledPosts, pageNumber, postsPerPage);
	return slicedPosts.length > 0 ? slicedPosts : null;
}
