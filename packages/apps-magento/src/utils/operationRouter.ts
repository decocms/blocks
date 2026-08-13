/**
 * URL-derived operation name router for Magento API calls.
 *
 * Plugged into `@decocms/blocks/sdk/instrumentedFetch`'s `resolveOperation`
 * option. Mirrors the VTEX/Shopify routers. Magento's surface from this repo is
 * a mix of GraphQL (`/graphql`) and REST (`/rest/<store>/V1/...`); the URL alone
 * can name the REST resource, while GraphQL calls fall back to a single
 * `graphql` operation (the semantic name lives in the document body, which
 * callers may stamp as `init.operation` to override this router).
 */

type OperationResolver = string | ((match: RegExpMatchArray, method: string) => string);

interface Matcher {
  pattern: RegExp;
  operation: OperationResolver;
}

const m = (pattern: RegExp, operation: OperationResolver): Matcher => ({ pattern, operation });

const MATCHERS: ReadonlyArray<Matcher> = [
  m(/\/graphql\b/, "graphql"),
  // REST: /rest/<storeCode>/V1/<resource>/... — name by the first resource segment.
  m(/\/rest\/[^/]+\/V1\/([^/?#]+)/, (match) => `rest.${match[1]}`),
  m(/\/rest\/V1\/([^/?#]+)/, (match) => `rest.${match[1]}`),
];

/**
 * Resolve an operation name for a Magento URL. Returns `undefined` when no
 * matcher fires, so the framework falls back to `magento.fetch`.
 */
import { extractPathname } from "@decocms/blocks/sdk/urlUtils";

export function magentoOperationRouter(url: string, _method: string): string | undefined {
  const pathname = extractPathname(url);

  for (const { pattern, operation } of MATCHERS) {
    const match = pathname.match(pattern);
    if (!match) continue;
    return typeof operation === "function" ? operation(match, _method) : operation;
  }
  return undefined;
}
