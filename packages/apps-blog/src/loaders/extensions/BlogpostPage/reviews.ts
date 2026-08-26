import { getReviews } from "../../../core/records";
import type { BlogPostPage, Ignore } from "../../../types";
import type { ExtensionOf } from "../types";

export interface Props {
  /**
   * @description Ignore specific reviews
   */
  ignoreReviews?: Ignore;
  /**
   * @description Order By
   */
  orderBy?: "date_asc" | "date_desc";
}

/**
 * @title ExtensionOf BlogPostPage: Reviews
 * @description It can harm performance. Use wisely
 */
export default function reviewsExt({
  ignoreReviews,
  orderBy,
}: Props): ExtensionOf<BlogPostPage | null> {
  return async (blogpostPage: BlogPostPage | null) => {
    if (!blogpostPage) {
      return null;
    }
    const post = await getReviews({ post: blogpostPage.post, ignoreReviews, orderBy });
    return { ...blogpostPage, post };
  };
}
