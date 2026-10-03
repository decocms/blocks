/**
 * GraphQL document helpers used by the client (`../wakeClient.ts`). Pure: no I/O, no framework imports.
 */

/**
 * Tagged-template helper that composes a GraphQL document string.
 * Kept identical to the Deno `gql` so `graphql/queries.ts` (which defines
 * `{ fragments, query }` objects) works verbatim.
 */
export function gql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
}

/** A Wake storefront operation: its document plus the fragments it spreads. */
export interface QueryDefinition {
  fragments?: string[];
  query: string;
}

export function buildQuery(def: QueryDefinition): string {
  const fragments = def.fragments?.join("\n") ?? "";
  return fragments ? `${fragments}\n${def.query}` : def.query;
}
