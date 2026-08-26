import { getRecordsByPath } from "../core/records";
import type { BlogPost, BlogPostPage } from "../types";
import { isLivePost } from "../types";

const COLLECTION_PATH = "collections/blog/posts";
const ACCESSOR = "post";

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

  return {
    "@type": "BlogPostPage",
    post,
    seo: {
      title: post?.seo?.title || post?.title,
      description: post?.seo?.description || post?.excerpt,
      canonical: post?.seo?.canonical || url.href,
      image: post?.seo?.image || post?.image,
      // A post that isn't live yet — unpublished, or scheduled for an instant
      // still ahead — renders anyway, because that page *is* the CMS preview.
      // It just must never be indexed, even if the URL leaks. A scheduled post
      // becomes indexable on its own once its instant passes.
      noIndexing: post?.seo?.noIndexing || !isLivePost(post),
    },
  };
}
