/**
 * Flatten a Magento REST `searchCriteria` object into a bracketed
 * query-string key/value map.
 *
 * Magento's search-criteria payload is deeply nested (filterGroups →
 * filters → field/value), but the REST API accepts it only as flat
 * `searchCriteria[filterGroups][0][filters][0][field]=name` style
 * query parameters. This helper walks the tree once and emits that
 * shape.
 *
 * Ported verbatim from `deco-cx/apps/magento/utils/stringifySearchCriteria.ts`
 * — the Fresh implementation is self-contained (no Deno-isms) and
 * produces output that prod consumers already depend on. Behavior
 * pinned by `__tests__/stringifySearchCriteria.test.ts`.
 *
 * @example
 *   stringifySearchCriteria({
 *     filterGroups: [{ filters: [{ field: "sku", value: "ABC" }] }],
 *   })
 *   // ⇒ { "searchCriteria[filterGroups][0][filters][0][field]": "sku",
 *   //     "searchCriteria[filterGroups][0][filters][0][value]": "ABC" }
 */
interface Filter {
	field: string;
	value: string;
}

interface FilterGroup {
	[key: string]: Filter[];
}

interface SearchCriteria {
	[key: string]: string | number | FilterGroup[];
}

type Path = string;
type TraverseObj = SearchCriteria | FilterGroup[];

function traverse(data: TraverseObj, result: Record<Path, string>, path: Path) {
	if (Array.isArray(data)) {
		data.forEach((item, index) => {
			traverse(item as unknown as TraverseObj, result, `${path}[${index}]`);
		});
	} else if (typeof data === "object" && data !== null) {
		for (const key in data) {
			if (Object.hasOwn(data, key)) {
				// @ts-expect-error recursive function with heterogeneous values
				traverse(data[key], result, `${path}[${key}]`);
			}
		}
	} else {
		result[path] = data;
	}
}

export default function stringifySearchCriteria(
	searchCriteriaObj: SearchCriteria,
): Record<Path, string> {
	const result: Record<Path, string> = {};
	traverse(searchCriteriaObj, result, "searchCriteria");
	return result;
}
