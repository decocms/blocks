# `@decocms/apps-magento`

A client for one Magento store's REST and GraphQL APIs. Everything goes to the store's
own origin.

## Configure

```ts
import { createMagentoClient } from "@decocms/apps-magento";

export const magento = createMagentoClient(
  {
    baseUrl: "https://store.example.com", // only its origin is used
    apiKey: secrets.MAGENTO_API_KEY,      // integration token, optional
    originHeader: secrets.MAGENTO_ORIGIN, // optional, sent as x-origin-header
  },
  { fetch: cachedFetch }, // optional
);
```

- `originHeader` is for stores behind an origin guard that expects a shared value.
- Exports: `createMagentoClient`, `MagentoClient`, `MagentoClientConfig`,
  `MagentoClientOptions`, `MagentoError`, `MagentoRequestInit`.

## Three ways to call

| Call | Returns | `apiKey` sent by default |
|---|---|---|
| `request(path, { operation, authenticated?, ...init })` | the raw `Response` | yes |
| `rest<T>(path, { operation, authenticated?, ...init })` | parsed JSON (`undefined` on 204) | yes |
| `graphql<T, V>(query, variables, { operationName, headers?, authenticated? })` | `data` | no |

- **Paths only.** `request` and `rest` resolve the path against the store's origin and
  throw if the result is another origin, so the token never leaves the store.
- **`operation` is required** on `request`/`rest`, and `operationName` on `graphql`. It
  is the telemetry label and appears in errors. Use the API's own name (`getCart`), never
  a URL.
- **The bearer token.** With `authenticated` true and an `apiKey`, the client sets
  `Authorization: Bearer <apiKey>`, unless the call already set an `Authorization`
  header. Pass a customer token as `Authorization` for customer calls; the integration
  token never replaces it.
- **GraphQL is public** on Magento, so `graphql` sends the `apiKey` only with
  `authenticated: true`. Pass the store view as a `Store` header when needed.
- `rest` sets `content-type: application/json` when there is a body and none was set.
  `graphql` always sends `operationName` in the body.

## Errors

`MagentoError` has `operation`, `status` and `graphqlErrors` (0 for an HTTP failure).
`request` doesn't throw on an HTTP error; it returns the response. No retries or circuit
breaker.

Customer and cart calls carry a customer token or session: run them in a server
function and don't cache them. Caching catalog reads is the site's job:
[`instrumented-fetch.md`](./instrumented-fetch.md).
