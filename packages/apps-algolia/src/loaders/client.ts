/**
 * Returns the configured Algolia SearchClient.
 *
 * Mirrors `apps/algolia/loaders/client.ts` (deco-cx/apps) so site code
 * doing `await invoke.algolia.loaders.client({})` keeps the same call
 * shape during the Fresh → TanStack migration. New code in the same
 * module can also `import { getAlgoliaClient } from
 * "@decocms/apps/algolia/client"` directly, skipping the invoke
 * round-trip when on the server.
 */

import { getAlgoliaClient, type SearchClient } from "../client";

/**
 * @title Algolia Search Client
 * @description Returns the SDK SearchClient configured at app boot.
 */
export default function loader(): SearchClient {
	return getAlgoliaClient();
}

export type { SearchClient };
