import { getRatings } from "../../../core/records";
import type { BlogPostListingPage, Ignore } from "../../../types";
import type { ExtensionOf } from "../types";

export interface Props {
  /**
   * @description Ignore ratings in the aggregateRating calc
   */
  ignoreRatings?: Ignore;
  /**
   * @description Return only aggregate rating object
   */
  onlyAggregate?: boolean;
}

/**
 * @title ExtensionOf BlogPostListing: Ratings
 * @description It can harm performance. Use wisely
 */
export default function ratingsExt({
  ignoreRatings,
  onlyAggregate,
}: Props): ExtensionOf<BlogPostListingPage | null> {
  return async (blogpostListingPage: BlogPostListingPage | null) => {
    if (!blogpostListingPage) {
      return null;
    }

    const posts = await Promise.all(
      blogpostListingPage.posts.map(async (post) => {
        const ratings = await getRatings({ post, onlyAggregate, ignoreRatings });
        return { ...post, ...ratings };
      }),
    );

    return { ...blogpostListingPage, posts };
  };
}
