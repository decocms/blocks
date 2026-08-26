import { logger, serializeError } from "@decocms/blocks/sdk/logger";
import { getBlogRecordsAdapter } from "../core/blogRecords";

export interface Props {
  id: string;
}

/**
 * Increments the view counter for a post, returning the new total.
 *
 * Returns `{ count: 0 }` when no adapter is registered: the caller is a
 * fire-and-forget beacon on page view, so a site without the backend should get
 * a well-formed response rather than an error.
 */
export default async function submitView({ id }: Props): Promise<{ count: number }> {
  const increment = getBlogRecordsAdapter()?.incrementPostView;
  if (!increment) {
    return { count: 0 };
  }

  try {
    return await increment(id);
  } catch (e) {
    const error = serializeError(e);
    logger.error(error.message, { error, scope: "blog/submitView" });
    return { count: 0 };
  }
}
