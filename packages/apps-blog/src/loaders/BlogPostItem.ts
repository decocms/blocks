import { getRecordsByPath } from "../core/records";
import type { BlogPost } from "../types";
import { isLivePost } from "../types";
import { isDraftPreview } from "../utils/draftPreview";

export interface Props {
  slug: string;
}

/**
 * @title BlogPostItem
 * @description Fetches a single blog post by slug. Returns the BlogPost
 * directly (not wrapped in BlogPostPage).
 */
export default function BlogPostItem(
  props: Props & { __pageUrl?: string },
  req?: Request,
): BlogPost | null {
  const { slug } = props;
  if (!slug) return null;

  const posts = getRecordsByPath<BlogPost>("collections/blog/posts", "post");
  const post = posts.find((p) => p?.slug === slug);

  if (!post) return null;
  if (isLivePost(post)) return post;

  // A post that isn't live yet — unpublished, or scheduled for an instant still
  // ahead — is only served in a `?draft=true` preview, and then must never be
  // indexed. Everything else the post declared under `seo` is kept as-is, and a
  // scheduled post becomes indexable on its own once its instant passes.
  const url = new URL(req?.url ?? props.__pageUrl ?? "http://localhost/");
  if (!isDraftPreview(url)) return null;
  return { ...post, seo: { ...post.seo, noIndexing: true } };
}
