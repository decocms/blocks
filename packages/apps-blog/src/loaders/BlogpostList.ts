import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import { descendantSlugs } from "../core/categoryTree";
import handlePosts, { slicePosts } from "../core/handlePosts";
import { getRecordsByPath } from "../core/records";
import type { BlogPost, Category, SortBy } from "../types";

const COLLECTION_PATH = "collections/blog/posts";
const ACCESSOR = "post";
const CATEGORIES_PATH = "collections/blog/categories";
const CATEGORY_ACCESSOR = "category";

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
   * @description Filter by a category slug. May be a full path
   * ("parent/child"); posts of every subcategory below the last segment are
   * included.
   */
  slug?: string;
  /**
   * @title Specific post slugs
   * @description Filter by specific post slugs.
   */
  postSlugs?: string[];
  /**
   * @title Page sorting parameter
   * @description The sorting option. Default is "date_desc"
   */
  sortBy?: SortBy;
  /**
   * @description Overrides the query term at url
   */
  query?: string;
}

/**
 * @title BlogPostList
 * @description Retrieves a flat list of blog posts.
 */
export default async function BlogPostList(
  props: Props & { __pageUrl?: string },
  req?: Request,
): Promise<BlogPost[] | null> {
  const { page, count, slug, sortBy, postSlugs, query } = props;
  const rawUrl = req?.url ?? props.__pageUrl ?? "http://localhost/";
  const url = new URL(rawUrl);
  const params = url.searchParams;
  const postsPerPage = Number(count ?? params.get("count") ?? 12);
  const pageNumber = Number(page ?? params.get("page") ?? 1);
  const pageSort = sortBy ?? (params.get("sortBy") as SortBy) ?? "date_desc";
  const term = query ?? params.get("q") ?? undefined;

  const posts = getRecordsByPath<BlogPost>(COLLECTION_PATH, ACCESSOR);

  try {
    // A parent category also lists its descendants' posts, so the slug expands
    // into the whole subtree below it.
    const leafSlug = (slug ?? "").split("/").filter(Boolean).pop();
    let categorySlugs: string | string[] | undefined = leafSlug;

    if (leafSlug && !postSlugs?.length) {
      try {
        const categories = getRecordsByPath<Category>(CATEGORIES_PATH, CATEGORY_ACCESSOR);
        categorySlugs = descendantSlugs(leafSlug, categories);
      } catch (e) {
        const error = serializeError(e);
        logger.error(error.message, { error, scope: "blog/BlogpostList/categories" });
      }
    }

    const handledPosts = await handlePosts(posts, pageSort, categorySlugs, postSlugs, term);

    if (!handledPosts) return null;

    const slicedPosts = slicePosts(handledPosts, pageNumber, postsPerPage);

    return slicedPosts.length > 0 ? slicedPosts : null;
  } catch (e) {
    const error = serializeError(e);
    logger.error(error.message, { error, scope: "blog/BlogpostList" });
    return null;
  }
}
