/**
 * Tests for stringifySearchCriteria.
 *
 * Parity goal with deco-cx/apps/magento/utils/stringifySearchCriteria.ts
 * — the Fresh implementation produces query-string keys that Magento's
 * REST API depends on byte-for-byte. These tests pin the exact bracket
 * layout so the port can't silently drift from prod.
 */
import { describe, expect, it } from "vitest";
import stringifySearchCriteria from "../utils/stringifySearchCriteria";

describe("stringifySearchCriteria", () => {
	it("flattens a top-level scalar field into a bracketed key", () => {
		expect(
			stringifySearchCriteria({
				pageSize: 20,
			}),
		).toEqual({
			"searchCriteria[pageSize]": 20,
		});
	});

	it("flattens nested objects with the [key] path style", () => {
		expect(
			stringifySearchCriteria({
				filterGroups: [
					{
						filters: [{ field: "sku", value: "ABC" }],
					},
				],
			}),
		).toEqual({
			"searchCriteria[filterGroups][0][filters][0][field]": "sku",
			"searchCriteria[filterGroups][0][filters][0][value]": "ABC",
		});
	});

	it("handles multiple filterGroups (OR semantics in Magento)", () => {
		const out = stringifySearchCriteria({
			filterGroups: [
				{ filters: [{ field: "sku", value: "A" }] },
				{ filters: [{ field: "sku", value: "B" }] },
			],
		});
		expect(out).toEqual({
			"searchCriteria[filterGroups][0][filters][0][field]": "sku",
			"searchCriteria[filterGroups][0][filters][0][value]": "A",
			"searchCriteria[filterGroups][1][filters][0][field]": "sku",
			"searchCriteria[filterGroups][1][filters][0][value]": "B",
		});
	});

	it("returns an empty object for empty input", () => {
		expect(stringifySearchCriteria({})).toEqual({});
	});
});
