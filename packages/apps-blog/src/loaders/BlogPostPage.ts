import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import { ancestorsOf, indexCategories, withCategoryPath } from "../core/categoryTree";
import { getRecordsByPath } from "../core/records";
import type { BlogPost, BlogPostPage, Category } from "../types";
import { isLivePost } from "../types";

const COLLECTION_PATH = "collections/blog/posts";
const ACCESSOR = "post";
const CATEGORIES_PATH = "collections/blog/categories";
const CATEGORY_ACCESSOR = "category";

export interface Props {
  slug: string;
}

/**
 * @title BlogPostPage
 * @description Fetches a specific blog post page by its slug.
 */
export default function BlogPostPageLoader(
  props: Props & { __pageUrl?: string },
  req?: Request,
): BlogPostPage | null {
  const { slug } = props;
  const posts = getRecordsByPath<BlogPost>(COLLECTION_PATH, ACCESSOR);

  const rawUrl = req?.url ?? props.__pageUrl ?? "http://localhost/";
  const url = new URL(rawUrl);
  const post = posts.find((p) => p?.slug === slug);

  if (!post) return null;

  // The post lives under the full path of its primary category, so the
  // breadcrumb and the canonical need that category's ancestor chain. A broken
  // categories collection must not take the post page down with it.
  let categories: Category[] = [];
  try {
    categories = getRecordsByPath<Category>(CATEGORIES_PATH, CATEGORY_ACCESSOR) ?? [];
  } catch (e) {
    const error = serializeError(e);
    logger.error(error.message, { error, scope: "blog/BlogPostPage/categories" });
  }

  const primarySlug = post.categories?.[0]?.slug;
  const chain =
    typeof primarySlug === "string" && primarySlug
      ? ancestorsOf(primarySlug, indexCategories(categories))
      : null;

  // Only a chain that came out of the records is trustworthy enough to name a
  // canonical URL; withCategoryPath itself returns null when the route has no
  // category segment to replace, so a /blog/:slug site keeps its own URL.
  const canonical = chain
    ? withCategoryPath(url, chain, {
        knownSlugs: new Set(categories.map((c) => c?.slug)),
        trailing: post.slug,
      })
    : null;

  return {
    "@type": "BlogPostPage",
    post,
    categories: chain ?? (post.categories?.[0] ? [post.categories[0]] : null),
    seo: {
      title: post?.seo?.title || post?.title,
      description: post?.seo?.description || post?.excerpt,
      canonical: post?.seo?.canonical || canonical || url.href,
      image: post?.seo?.image || post?.image,
      // A post that isn't live yet — unpublished, or scheduled for an instant
      // still ahead — renders anyway, because that page *is* the CMS preview.
      // It just must never be indexed, even if the URL leaks. A scheduled post
      // becomes indexable on its own once its instant passes.
      noIndexing: post?.seo?.noIndexing || !isLivePost(post),
    },
  };
}
