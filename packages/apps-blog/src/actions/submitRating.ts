import type { Person } from "@decocms/apps-commerce/types";
import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import { getBlogRecordsAdapter } from "../core/blogRecords";
import type { Rating } from "../types";

export interface Props {
  itemReviewed: string;
  author: Person;
  ratingValue: number;
  additionalType?: string;
}

/**
 * Records this author's rating for a post, replacing their previous one.
 *
 * The "one rating per author per item" rule lives in the adapter rather than
 * here: the Deno app implemented it as a `select ... where itemReviewed = ? and
 * (author like %email% or author like %@id%)` followed by an update, which is a
 * query the site's schema owns. See `core/blogRecords.ts`.
 *
 * Returns `null` when no adapter is registered — ratings are opt-in.
 */
export default async function submitRating(props: Props): Promise<Rating | null> {
  const upsert = getBlogRecordsAdapter()?.upsertRating;
  if (!upsert) {
    return null;
  }

  try {
    return await upsert(props);
  } catch (e) {
    const error = serializeError(e);
    logger.error(error.message, { error, scope: "blog/submitRating" });
    return null;
  }
}
