import { getRatings } from "../../../core/records";
import type { BlogPost, Ignore } from "../../../types";
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
 * @title ExtensionOf BlogPost list: Ratings
 * @description It can harm performance. Use wisely
 */
export default function ratingsExt({
  ignoreRatings,
  onlyAggregate,
}: Props): ExtensionOf<BlogPost[] | null> {
  return async (posts: BlogPost[] | null) => {
    if (!posts || posts.length === 0) {
      return null;
    }

    return Promise.all(
      posts.map(async (post) => {
        const ratings = await getRatings({ post, ignoreRatings, onlyAggregate });
        return { ...post, ...ratings };
      }),
    );
  };
}
