import { type FetchFn, withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import type { InstrumentedFetchInit } from "@decocms/blocks/sdk/instrumentedFetch";
import { extractGraphqlOperationName } from "./graphqlOperationName";

export function gql(strings: TemplateStringsArray, ...values: unknown[]): string {
	return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
}

export interface QueryDefinition {
	fragments?: string[];
	query: string;
}

export function buildQuery(def: QueryDefinition): string {
	const fragments = def.fragments?.join("\n") ?? "";
	return fragments ? `${fragments}\n${def.query}` : def.query;
}

export interface GraphQLErrorEntry {
	message: string;
	extensions?: { code?: string };
}

/** Thrown when the response carries `errors`; keeps them for callers that branch on the code. */
export class ShopifyGraphQLError extends Error {
	constructor(readonly errors: GraphQLErrorEntry[]) {
		super(`Shopify GraphQL errors: ${errors.map((e) => e.message).join(", ")}`);
		this.name = "ShopifyGraphQLError";
	}
}

export interface GraphQLClient {
	query<T>(query: string | QueryDefinition, variables?: Record<string, unknown>): Promise<T>;
}

export function createGraphqlClient(
	endpoint: string,
	headers: Record<string, string>,
	fetchFn?: FetchFn,
): GraphQLClient {
	const _fetch = fetchFn ?? withFetchTimeout();
	return {
		async query<T>(
			queryOrDef: string | QueryDefinition,
			variables?: Record<string, unknown>,
		): Promise<T> {
			const query = typeof queryOrDef === "string" ? queryOrDef : buildQuery(queryOrDef);

			// Stamp the GraphQL operation as init.operation so the framework's
			// span name becomes `shopify.<OperationName>` instead of the
			// generic `shopify.storefront.graphql` from the URL router. The
			// extra field is silently dropped by plain `fetch` and read by
			// any `InstrumentedFetch` configured via `setShopifyFetch`.
			const operation = extractGraphqlOperationName(query);
			const init: InstrumentedFetchInit = {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body: JSON.stringify({ query, variables }),
				...(operation ? { operation } : {}),
			};
			const response = await _fetch(endpoint, init);

			if (!response.ok) {
				throw new Error(`Shopify GraphQL error: ${response.status} ${response.statusText}`);
			}

			const json = (await response.json()) as { data?: T; errors?: GraphQLErrorEntry[] };

			if (json.errors?.length) {
				throw new ShopifyGraphQLError(json.errors);
			}

			if (json.data === undefined) {
				throw new Error("Shopify GraphQL response missing data");
			}

			return json.data;
		},
	};
}
