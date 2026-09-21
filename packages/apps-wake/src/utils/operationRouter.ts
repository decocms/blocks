/**
 * URL-derived operation name router for Wake API calls.
 *
 * Plugged into `@decocms/blocks`'s `createInstrumentedFetch` via the
 * `resolveOperation(url, method)` option. Wake's API surface here is the
 * GraphQL storefront (`/graphql`) plus a couple of checkout REST endpoints.
 * The semantic GraphQL operation name is extracted from the document itself
 * (see `./graphqlOperationName.ts`) and stamped as `init.operation`, which
 * always wins over this router; this router is the fallback.
 */

type OperationResolver = string | ((match: RegExpMatchArray, method: string) => string);

interface Matcher {
  pattern: RegExp;
  operation: OperationResolver;
}

const m = (pattern: RegExp, operation: OperationResolver): Matcher => ({ pattern, operation });

const MATCHERS: ReadonlyArray<Matcher> = [
  m(/^\/graphql/, "storefront.graphql"),
  m(/^\/api\/Login\/Get/, "checkout.login"),
  m(/^\/api\/carrinho/, "checkout.cart"),
  m(/^\/api\//, "checkout.api"),
  m(/^\/Sitemap\.xml/i, "sitemap"),
];

/**
 * Resolve an operation name for a Wake URL. Returns `undefined` if no matcher
 * fires, which causes the framework to fall back to `wake.fetch`.
 */
export function wakeOperationRouter(url: string, method: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    const qs = url.indexOf("?");
    const hash = url.indexOf("#");
    const end = [qs, hash].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    pathname = end === undefined ? url : url.slice(0, end);
  }

  const upperMethod = method.toUpperCase();
  for (const { pattern, operation } of MATCHERS) {
    const match = pathname.match(pattern);
    if (!match) continue;
    return typeof operation === "function" ? operation(match, upperMethod) : operation;
  }
  return undefined;
}
