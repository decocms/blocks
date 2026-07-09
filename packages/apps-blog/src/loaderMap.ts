/**
 * Blog loader map factory for CMS block resolution.
 *
 * Returns a `Record<string, LoaderFn>` that the site spreads into its
 * block loader registry.
 */

import AuthorLoader from "./loaders/Author";
import BlogPostItemLoader from "./loaders/BlogPostItem";
import BlogPostPageLoader from "./loaders/BlogPostPage";
import BlogpostLoader from "./loaders/Blogpost";
import BlogpostListingLoader from "./loaders/BlogpostListing";
import BlogRelatedPostsLoader from "./loaders/BlogRelatedPosts";
import CategoryLoader from "./loaders/Category";
import GetCategoriesLoader from "./loaders/GetCategories";

// biome-ignore lint/suspicious/noExplicitAny: loader props/returns vary per block
export type LoaderFn = (props: any, request?: Request) => Promise<any> | any;

/**
 * Create the blog loader map.
 *
 * @example
 * ```ts
 * import { createBlogLoaders } from "@decocms/apps/blog";
 *
 * const COMMERCE_LOADERS = {
 *   ...createVtexCommerceLoaders(),
 *   ...createBlogLoaders(),
 * };
 * ```
 */
export function createBlogLoaders(): Record<string, LoaderFn> {
	return {
		// Loader keys match the Deno app's __resolveType paths
		"blog/loaders/BlogPostPage.ts": BlogPostPageLoader,
		"blog/loaders/BlogPostPage": BlogPostPageLoader,
		"blog/loaders/BlogpostListing.ts": BlogpostListingLoader,
		"blog/loaders/BlogpostListing": BlogpostListingLoader,
		"blog/loaders/BlogRelatedPosts.ts": BlogRelatedPostsLoader,
		"blog/loaders/BlogRelatedPosts": BlogRelatedPostsLoader,
		"blog/loaders/GetCategories.ts": GetCategoriesLoader,
		"blog/loaders/GetCategories": GetCategoriesLoader,
		"blog/loaders/Blogpost.ts": BlogpostLoader,
		"blog/loaders/Blogpost": BlogpostLoader,
		"blog/loaders/Category.ts": CategoryLoader,
		"blog/loaders/Category": CategoryLoader,
		"blog/loaders/Author.ts": AuthorLoader,
		"blog/loaders/Author": AuthorLoader,

		// BlogPostItem: looks up a single post by slug, returns BlogPost
		"blog/loaders/BlogPostItem.ts": BlogPostItemLoader,
		"blog/loaders/BlogPostItem": BlogPostItemLoader,
		"blog/loaders/BlogpostList.ts": BlogpostListingLoader,
		"blog/loaders/BlogpostList": BlogpostListingLoader,
	};
}
