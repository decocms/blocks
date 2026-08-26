import { loadBlocks } from "@decocms/blocks/cms";
import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import type { BlogPost, Ignore, Rating, Review } from "../types";
import { getBlogRecordsAdapter } from "./blogRecords";

/**
 * Retrieve records from CMS blocks by path prefix.
 *
 * Scans the decofile blocks whose key starts with `path` and extracts the
 * nested value at `accessor` from each matching block.
 *
 * Equivalent to the Deno `getRecordsByPath(ctx, path, accessor)` but uses
 * `loadBlocks()` from `@decocms/blocks/cms` instead of `ctx.get(resolvables)`.
 */
export function getRecordsByPath<T>(path: string, accessor: string): T[] {
  const blocks = loadBlocks() as Record<string, Record<string, unknown>>;
  const results: T[] = [];

  for (const [key, value] of Object.entries(blocks)) {
    if (!key.startsWith(path) || !value || typeof value !== "object") {
      continue;
    }

    const record = value[accessor] as T | undefined;
    if (!record) continue;

    const id = (value.name as string | undefined)?.split(path)[1]?.replace("/", "");

    results.push({ ...record, id } as T);
  }

  return results;
}

const report = (scope: string, e: unknown) => {
  const error = serializeError(e);
  logger.error(error.message, { error, scope });
};

/**
 * Ratings for one post, normalised with the rating scale.
 *
 * `bestRating`/`worstRating` are stamped here rather than stored, matching
 * upstream: the scale is a property of this app's UI, not of the record.
 */
export async function getRatingsBySlug({ slug }: { slug: string }): Promise<Rating[]> {
  try {
    const currentRatings = await getBlogRecordsAdapter()?.listRatings?.(slug);

    return (currentRatings ?? []).map((rating) => ({
      ...rating,
      bestRating: 5,
      worstRating: 1,
    }));
  } catch (e) {
    report("blog/getRatingsBySlug", e);
    return [];
  }
}

/** Returns the post enriched with its ratings and their aggregate. */
export async function getRatings({
  post,
  ignoreRatings,
  onlyAggregate,
}: {
  post: BlogPost;
  ignoreRatings?: Ignore;
  onlyAggregate?: boolean;
}): Promise<BlogPost> {
  const contentRating = await getRatingsBySlug({ slug: post.slug });

  const { ratingCount, ratingTotal } =
    contentRating.length === 0
      ? { ratingCount: 0, ratingTotal: 0 }
      : contentRating.reduce(
          (acc, { ratingValue, additionalType }) =>
            ignoreRatings?.active &&
            additionalType &&
            ignoreRatings.markedAs?.includes(additionalType)
              ? acc
              : {
                  ratingCount: acc.ratingCount + 1,
                  ratingTotal: acc.ratingTotal + (ratingValue ?? 0),
                },
          { ratingCount: 0, ratingTotal: 0 },
        );

  const ratingValue = ratingTotal / ratingCount;

  return {
    ...post,
    contentRating: onlyAggregate ? undefined : contentRating,
    aggregateRating: {
      ...post.aggregateRating,
      "@type": "AggregateRating",
      ratingCount,
      ratingValue: Number.isNaN(ratingValue) ? 0 : ratingValue,
      bestRating: 5,
      worstRating: 1,
    },
  };
}

export const getReviewById = async ({ id }: { id?: string }): Promise<Review | null> => {
  if (!id) {
    return null;
  }
  try {
    return (await getBlogRecordsAdapter()?.getReview?.(id)) ?? null;
  } catch (e) {
    report("blog/getReviewById", e);
    return null;
  }
};

export async function getReviewsBySlug({
  slug,
  ignoreReviews,
  orderBy = "date_desc",
}: {
  slug: string;
  ignoreReviews?: Ignore;
  orderBy?: "date_asc" | "date_desc";
}): Promise<Review[]> {
  const excludeAdditionalTypes =
    ignoreReviews?.active && ignoreReviews.markedAs && ignoreReviews.markedAs.length > 0
      ? ignoreReviews.markedAs
      : undefined;

  try {
    const currentComments = await getBlogRecordsAdapter()?.listReviews?.({
      slug,
      excludeAdditionalTypes,
      orderBy,
    });

    return currentComments ?? [];
  } catch (e) {
    report("blog/getReviewsBySlug", e);
    return [];
  }
}

/** Returns the post enriched with its reviews and their count. */
export async function getReviews({
  post,
  ...rest
}: {
  post: BlogPost;
  ignoreReviews?: Ignore;
  orderBy?: "date_asc" | "date_desc";
}): Promise<BlogPost> {
  const review = await getReviewsBySlug({ slug: post.slug, ...rest });

  return {
    ...post,
    review,
    aggregateRating: {
      ...post.aggregateRating,
      "@type": "AggregateRating",
      reviewCount: review.length,
    },
  };
}
