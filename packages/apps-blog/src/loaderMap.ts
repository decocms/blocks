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
import BlogpostListLoader from "./loaders/BlogpostList";
import BlogpostListingLoader from "./loaders/BlogpostListing";
import BlogRelatedPostsLoader from "./loaders/BlogRelatedPosts";
import CategoryLoader from "./loaders/Category";
import GetCategoriesLoader from "./loaders/GetCategories";

export type LoaderFn = (props: any, request?: Request) => Promise<any> | any;

/**
 * Create the blog loader map.
 *
 * Each loader is registered under both key forms the resolver may see: the
 * Deno app's `__resolveType` paths carry a `.ts` suffix, while manifest-derived
 * keys do not.
 *
 * @example
 * ```ts
 * import { createBlogLoaders } from "@decocms/apps-blog";
 *
 * const COMMERCE_LOADERS = {
 *   ...createVtexCommerceLoaders(),
 *   ...createBlogLoaders(),
 * };
 * ```
 */
export function createBlogLoaders(): Record<string, LoaderFn> {
  const byName: Record<string, LoaderFn> = {
    "blog/loaders/BlogPostPage": BlogPostPageLoader,
    "blog/loaders/BlogpostListing": BlogpostListingLoader,
    // A distinct loader from BlogpostListing: it takes `postSlugs` and returns
    // a flat BlogPost[] rather than a BlogPostListingPage. It used to be
    // aliased to the listing loader here, which silently dropped `postSlugs`
    // and handed callers the wrong shape.
    "blog/loaders/BlogpostList": BlogpostListLoader,
    "blog/loaders/BlogRelatedPosts": BlogRelatedPostsLoader,
    "blog/loaders/GetCategories": GetCategoriesLoader,
    "blog/loaders/Blogpost": BlogpostLoader,
    "blog/loaders/Category": CategoryLoader,
    "blog/loaders/Author": AuthorLoader,
    // BlogPostItem: looks up a single post by slug, returns BlogPost
    "blog/loaders/BlogPostItem": BlogPostItemLoader,
  };

  return Object.fromEntries(
    Object.entries(byName).flatMap(([key, fn]) => [
      [key, fn],
      [`${key}.ts`, fn],
    ]),
  );
}
