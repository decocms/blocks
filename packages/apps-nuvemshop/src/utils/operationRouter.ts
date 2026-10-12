/**
 * URL → operation name for Nuvemshop egress (Storefront API, the store's own
 * session endpoints, the Admin API and Turnstile), plugged into
 * `createInstrumentedFetch`'s `resolveOperation`. Returns `undefined` when
 * nothing matches so the framework falls back to `nuvemshop.fetch`.
 */
import { extractPathname } from "@decocms/blocks/sdk/urlUtils";

const MATCHERS: ReadonlyArray<[RegExp, string]> = [
  [/\/stores\/\d+\/search\/products\/?$/, "products.search"],
  [/\/stores\/\d+\/products\/?$/, "products.browse"],
  [/\/stores\/\d+\/products\/[^/]+\/?$/, "products.get"],
  [/\/stores\/\d+\/categories\/?$/, "categories.list"],
  [/\/stores\/\d+\/categories\/[^/]+\/?$/, "categories.get"],
  [/\/stores\/\d+\/shipping-options\/?$/, "shipping.options"],
  [/\/stores\/\d+\/checkouts\/?$/, "checkout.create"],
  [/^\/account\/login\/?$/, "store.account.login"],
  [/^\/account\/logout\/?$/, "store.account.logout"],
  [/^\/account\/?$/, "store.account.page"],
  [/^\/v1\/\d+\/customers(\/\d+)?\/?$/, "admin.customers"],
  [/^\/turnstile\/v0\/siteverify$/, "turnstile.verify"],
];

export function nuvemshopOperationRouter(url: string, _method: string): string | undefined {
  const pathname = extractPathname(url);
  return MATCHERS.find(([pattern]) => pattern.test(pathname))?.[1];
}
