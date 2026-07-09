/**
 * Public API for the blog app.
 */

export { getRecordsByPath } from "./core/records";
/** @deprecated Use `createBlogLoaders` instead. */
export {
	createBlogLoaders,
	createBlogLoaders as createBlogCommerceLoaders,
} from "./loaderMap";
export { configure } from "./mod";

// Types
export type {
	Author,
	BlogPost,
	BlogPostListingPage,
	BlogPostPage,
	Category,
	ExtraProps,
	PageInfo,
	Seo,
	SortBy,
} from "./types";
