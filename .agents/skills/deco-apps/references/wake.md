# `@decocms/apps-wake`

A client for Wake's Storefront GraphQL API, plus the one checkout REST call a storefront
needs (`getLogin`). Operations and their generated types ship with it.

## Configure

```ts
import { createWakeClient } from "@decocms/apps-wake";

export const wake = createWakeClient(
  {
    storefrontToken: secrets.WAKE_TOKEN,              // sent as TCS-Access-Token
    checkoutUrl: "https://acme.checkout.fbits.store", // needed by getLogin
    // storefrontEndpoint: defaults to https://storefront-api.fbits.net/graphql
  },
  { fetch: cachedFetch }, // optional
);
```

Exports: `createWakeClient`, `WakeClient`, `WakeClientConfig`, `WakeClientOptions`,
`WakeError`, and the type `UserAuthenticate`.

## Run an operation

```ts
import { GetProduct } from "@decocms/apps-wake/storefront";
import type { GetProductQuery, GetProductQueryVariables } from "@decocms/apps-wake/storefront/types";

const data = await wake.graphql<GetProductQuery, GetProductQueryVariables>(GetProduct, { productId: 1 });
```

- `graphql(document, variables?, { headers? })` takes a string or one of the operation
  objects (`{ query, fragments? }`) from `/storefront`, and returns `data`.
- `/storefront` exports Wake's Storefront operations: `GetProduct`, `GetProducts`, `Search`,
  `Autocomplete`, `ProductRecommendations`, `GetURL`, `Hotsite`, `Shop`,
  `GetCart`, `CreateCart`, `AddItemToCart`, `RemoveItemFromCart`, `AddCoupon`,
  `RemoveCoupon`, `AddKit`, `RemoveKit`, `ShippingQuotes`, `GetUser`, `GetWishlist`,
  `WishlistAddProduct`, `WishlistRemoveProduct`, `ProductRestockAlert`,
  `CreateNewsletterRegister`, `CreateProductReview`, `SendGenericForm`, `GetBuyList`,
  `GetPartners`, `CheckoutPartnerAssociate`, `CheckoutPartnerDisassociate`, and more.
  `/storefront/types` has a `…Query` or `…Mutation` type and a `…Variables` type for
  each, named after the GraphQL operation inside, not the export: `GetURL` →
  `GetUrlQuery`, `GetBuyList` → `BuyListQuery`.
- Per-call `headers` add things such as `X-Forwarded-For` or a customer access token.
  They can't override the token or the content type.
- The label is the document's operation name; an unnamed one is `graphql`.
- This call takes no `signal`.

## `getLogin(cookie)`

`GET {checkoutUrl}/api/Login/Get` with the shopper's checkout cookies (the
`fbits-login` cookie). It returns the shopper's account (`UserAuthenticate`: `Id`,
`Email`, `Name`, `Cpf`, `CustomerAccessToken`, …) or `null` when they aren't signed in
(401, 403 or 404). Any other failure, such as a 429, throws `WakeError`. It throws a
plain `Error` when `checkoutUrl` isn't set.

Customer operations take the returned `CustomerAccessToken` as the
`customerAccessToken` variable (`GetUser`, `WishlistAddProduct`, …). Both the cookie
and the token are per shopper: run these in a server function and don't cache the
results.

## Errors

`WakeError` has `operation`, `status` and `graphqlErrors` (how many GraphQL errors the
response had; 0 for an HTTP failure). A response with no `data` also throws. No retries
or circuit breaker.

## Vendored GraphQL documents

A migrated site may keep v7's `queries.ts` under `src/vendor/wake`. Don't run a
formatter over it: a reflowed document changes every request body, and a replaying
parity harness misses every call. Prefer the operations from
`@decocms/apps-wake/storefront` once parity is done.
