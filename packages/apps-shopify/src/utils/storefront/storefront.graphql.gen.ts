/**
 * Shopify Storefront API GraphQL type stubs.
 * These replace the auto-generated types from the original deco-cx/apps.
 * Types are simplified but maintain the interface contract.
 */

// Cart types
export type CartFragment = {
	id: string;
	checkoutUrl: string;
	totalQuantity: number;
	lines: {
		nodes: Array<{
			id: string;
			quantity: number;
			merchandise: {
				__typename?: string;
				id: string;
				title: string;
				image?: { url: string; altText?: string | null } | null;
				product: { title: string; handle: string; onlineStoreUrl?: string | null };
				price: { amount: string; currencyCode: string };
				compareAtPrice?: { amount: string; currencyCode: string } | null;
			};
			discountAllocations?: Array<{
				__typename?: string;
				code?: string;
			}>;
		}>;
	};
	cost: {
		totalAmount: { amount: string; currencyCode: string };
		subtotalAmount: { amount: string; currencyCode: string };
	};
	discountCodes?: Array<{ applicable: boolean; code: string }>;
};

// Mutation types
export type AddItemToCartMutation = { cart?: CartFragment | null };
export type AddItemToCartMutationVariables = { cartId: string; lines: unknown };
export type UpdateItemsMutation = { cart?: CartFragment | null };
export type UpdateItemsMutationVariables = { cartId: string; lines: unknown };
export type AddCouponMutation = { cart?: CartFragment | null };
export type AddCouponMutationVariables = { cartId: string; discountCodes: string[] };

// Product types — these are intentionally loose stubs because the
// real Shopify Storefront API GraphQL types are huge and only a tiny
// subset is consumed. `unknown` keeps consumers honest (forces a cast
// at the boundary) without exploding the type surface.
export type ProductFragment = unknown;
export type ProductVariantFragment = unknown;
export type GetProductQuery = { product?: unknown };
export type GetProductQueryVariables = { handle?: string; identifiers?: unknown[] };
export type ProductRecommendationsQuery = { productRecommendations?: unknown[] };
export type ProductRecommendationsQueryVariables = { productId: string };

// Search/Collection types
export type InputMaybe<T> = T | null | undefined;
export type ProductCollectionSortKeys = string;
export type SearchSortKeys = string;
// Loose shape derived from the only consumers in
// `shopify/utils/utils.ts` (filterToObject + getFiltersByUrl). Keeps
// the types honest without depending on Shopify's full GraphQL schema.
export type ProductFilter = {
	tag?: string;
	productType?: string;
	productVendor?: string;
	available?: boolean;
	price?: { min?: number; max?: number };
	variantOption?: { name: string; value: string };
	productMetafield?: { namespace: string; key: string; value: string };
	taxonomyMetafield?: { namespace: string; key: string; value: string };
	category?: { id: string };
};

// Customer types
export type Customer = {
	id: string;
	firstName?: string | null;
	lastName?: string | null;
	email?: string | null;
	phone?: string | null;
	acceptsMarketing?: boolean;
	defaultAddress?: unknown;
	addresses?: { nodes: unknown[] };
	orders?: { nodes: unknown[] };
};

export type CustomerAccessTokenCreateInput = {
	email: string;
	password: string;
};

export type CustomerAccessTokenCreateWithMultipassPayload = {
	customerAccessToken?: { accessToken: string; expiresAt: string } | null;
	customerUserErrors?: Array<{ message: string; code?: string }>;
};

export type CustomerCreateInput = {
	email: string;
	password: string;
	firstName?: string;
	lastName?: string;
	acceptsMarketing?: boolean;
};

export type CustomerCreatePayload = {
	customer?: Customer | null;
	customerUserErrors?: Array<{ message: string; code?: string }>;
};

// Shop types
export type Shop = {
	name: string;
	description?: string;
	shipsToCountries?: string[];
	refundPolicy?: { body: string; title: string; url: string };
	privacyPolicy?: { body: string; title: string; url: string };
	termsOfService?: { body: string; title: string; url: string };
	metafields?: Array<{ key: string; value: string; namespace: string } | null>;
};

export type ShopMetafieldsArgs = {
	identifiers: Array<{ namespace: string; key: string }>;
};

// Order/Admin types
export type CountryCode = string;
export type Maybe<T> = T | null;
