/**
 * Magento GraphQL request input types used by the product loaders.
 *
 * Subset of `deco-cx/apps/magento/utils/clientGraphql/types.ts` that the
 * port has reached so far — extended as more loaders land. These mirror
 * Magento's GraphQL schema for product search/sort/filter so the
 * storefront's URL params translate cleanly into GraphQL variables.
 */

/**
 * Magento ProductAttributeFilterInput shape — keys are Magento
 * attribute codes; values are one of the three filter-type unions.
 * Maps to: `filter: ProductAttributeFilterInput!`
 */
export interface ProductFilterInput {
	[key: string]: FilterEqualTypeInput | FilterMatchTypeInput | FilterRangeTypeInput;
}

/**
 * Magento `FilterEqualTypeInput` — for exact-match attributes (sku,
 * sale, color, size, etc.). `in` lets you OR multiple values; the
 * single-value `eq` form is also accepted by the Magento schema and is
 * the shape `transformFilterValueGraphQL` emits.
 */
export interface FilterEqualTypeInput {
	in?: string[];
	eq?: string;
}

/**
 * Magento `FilterMatchTypeInput` — substring-match attributes (name,
 * description, short_description).
 */
export interface FilterMatchTypeInput {
	match: string;
}

/**
 * Magento `FilterRangeTypeInput` — numeric ranges (price). Both bounds
 * are strings in the schema; ranges in URL params come as `from_to`.
 */
export interface FilterRangeTypeInput {
	from: string;
	to: string;
}

/**
 * Magento `ProductAttributeSortInput` — one entry per sortable
 * attribute keyed by attribute code, ordered ASC or DESC.
 */
export interface ProductSortInput {
	[key: string]: "ASC" | "DESC";
}

/**
 * Built-in sort options surfaced in the CMS admin. Custom options can
 * be added by sites via `CustomProductSortOption`.
 */
export interface DefaultProductSortOption {
	value: "name" | "position" | "price" | "relevance";
}

export interface CustomProductSortOption {
	value: string;
}

/**
 * Shared sort-prop shape used by PLP / list / relatedProducts loaders.
 */
export interface ProductSort {
	/** @title Order by */
	sortBy: DefaultProductSortOption | CustomProductSortOption;
	/** @title Sequency */
	order: "ASC" | "DESC";
}

/**
 * Loader-supplied filter (vs URL-derived). The site can hard-code
 * filters in the CMS section config and they layer on top of whatever
 * the user picked from URL params.
 */
export interface FilterProps {
	name: string;
	type: FilterEqualTypeInput | FilterMatchTypeInput | FilterRangeTypeInput;
}

/**
 * Custom-fields toggle used by `getCustomFields()` to decide which
 * Magento product attributes to project from a query.
 */
export interface CustomFields {
	/**
	 * @description Search for global custom fields defined in App settings
	 * @default false
	 */
	active: boolean;
	/** @description Will override global custom fields defined in App settings */
	overrideList?: string[];
}
