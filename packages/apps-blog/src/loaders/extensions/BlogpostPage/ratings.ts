import { getRatings } from "../../../core/records";
import type { BlogPostPage, Ignore } from "../../../types";
import type { ExtensionOf } from "../types";

export interface Props {
  /**
   * @description Ignore ratings in the aggregateRating calc
   */
  ignoreRatings?: Ignore;
}

/**
 * @title ExtensionOf BlogPostPage: Ratings
 * @description It can harm performance. Use wisely
 */
export default function ratingsExt({ ignoreRatings }: Props): ExtensionOf<BlogPostPage | null> {
  return async (blogpostPage: BlogPostPage | null) => {
    if (!blogpostPage) {
      return null;
    }
    const post = await getRatings({ post: blogpostPage.post, ignoreRatings });
    return { ...blogpostPage, post };
  };
}
