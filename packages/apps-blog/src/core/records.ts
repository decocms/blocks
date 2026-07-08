import { loadBlocks } from "@decocms/blocks/cms";

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
