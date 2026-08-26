import { getReviews } from "../../../core/records";
import type { BlogPost, Ignore } from "../../../types";
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
 * @title ExtensionOf BlogPost list: Reviews
 * @description It can harm performance. Use wisely
 */
export default function reviewsExt({
  ignoreReviews,
  orderBy,
}: Props): ExtensionOf<BlogPost[] | null> {
  return async (posts: BlogPost[] | null) => {
    if (!posts || posts.length === 0) {
      return null;
    }

    return Promise.all(
      posts.map(async (post) => {
        const reviews = await getReviews({ post, ignoreReviews, orderBy });
        return { ...post, ...reviews };
      }),
    );
  };
}
