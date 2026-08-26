import type { Person } from "@decocms/apps-commerce/types";
import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import { getBlogRecordsAdapter } from "../core/blogRecords";
import { getReviewById } from "../core/records";
import type { Review } from "../types";

export interface Props {
  action: "create" | "update";
  id?: string;
  reviewBody?: string;
  reviewHeadline?: string;
  itemReviewed?: string;
  author?: Person;
  /** Review status */
  additionalType?: string;
  isAnonymous?: boolean;
}

/**
 * Creates or updates a review. Returns `null` when no adapter is registered, or
 * when an update targets an id that doesn't exist.
 */
export default async function submitReview({
  reviewBody,
  reviewHeadline,
  itemReviewed,
  id,
  author,
  action,
  additionalType,
  isAnonymous,
}: Props): Promise<Review | null> {
  const adapter = getBlogRecordsAdapter();
  if (!adapter) {
    return null;
  }

  const isoDate = new Date().toISOString();

  try {
    if (action !== "create") {
      if (!adapter.updateReview) {
        return null;
      }
      // Read-before-write: the update is a partial patch, and the response has
      // to carry the fields the caller didn't send (author, datePublished).
      const storedReview = await getReviewById({ id });
      if (!storedReview || !id) {
        return null;
      }
      const updateRecord = {
        additionalType: additionalType ?? storedReview.additionalType,
        reviewHeadline: reviewHeadline ?? storedReview.reviewHeadline,
        reviewBody: reviewBody ?? storedReview.reviewBody,
        dateModified: isoDate,
      };

      const updated = await adapter.updateReview(id, updateRecord);

      return (
        updated ?? {
          ...updateRecord,
          "@type": "Review",
          id,
          itemReviewed: storedReview.itemReviewed,
          author: author ?? storedReview.author,
          datePublished: storedReview.datePublished,
        }
      );
    }

    if (!adapter.createReview) {
      return null;
    }

    const insertData = {
      itemReviewed,
      isAnonymous,
      author,
      additionalType,
      reviewHeadline,
      reviewBody,
      datePublished: isoDate,
      dateModified: isoDate,
    };

    const created = await adapter.createReview(insertData);

    return created ?? { "@type": "Review", ...insertData };
  } catch (e) {
    const error = serializeError(e);
    logger.error(error.message, { error, scope: "blog/submitReview" });
    return null;
  }
}
