# Accounts: register, login, logout, user

No API covers customer sessions. What works, validated against a live store:

| Action | Upstream | Notes |
|---|---|---|
| `actions/account/register` | Admin API `POST /customers` `{name,email,password,send_email_invite:false}` | The store's form needs a reCAPTCHA bound to its domain — posting it without the token is **silently rejected** (302 back, no account). The Admin API has no captcha, so the action requires Cloudflare Turnstile (`turnstileSecret`) unless `allowUnverifiedRegistration` (demos). Duplicate email → 422 → `email_taken`. |
| `actions/account/login` | store `POST /account/login/` (email, password) | Success = 302 to `/account/`. Failure = 302 back to the login page, whose HTML carries the reason: `js-login-general-error` (wrong credentials) or `js-account-validation-pending` (email not validated — every new account must click the email link first). The page also contains hidden copies of every message, so match the class, not the text. |
| `actions/account/logout` | store `GET /account/logout/` | |
| `loaders/user` | store `GET /account/` → `LS.customer = <id>`; Admin API `GET /customers/<id>` | `null` when there's no `store_*` cookie or `/account/` redirects to login. |

The store domain sits behind a Cloudflare WAF that 403-challenges requests with no `User-Agent` (the default from a Worker); `storeFetch` forwards the buyer's UA, falling back to `Mozilla/5.0 (compatible; deco-storefront)`.

## Cookies

The session is the store's `store_session_payload_<storeId>` (rewritten on
login) + `store_login_session`. `store.ts`:
- sends upstream only the request's `store_*` cookies (never the site's own);
- re-emits only `store_*` `Set-Cookie` into `RequestContext.responseHeaders`
  with `Domain` rewritten to our host (the store's Cloudflare `__cf_bm`/`_cfuvid`
  are dropped). Same cookie names as the store, so a checkout proxy would carry
  the same session.

## Admin token

`adminToken` is a custom-app token, server-only, often created with full
access. Never return it or Admin API payloads wholesale to the browser —
`user` returns only id/name/email/phone of the session's own customer.

## Customer data: profile, addresses, orders

| Export | Upstream | Notes |
|---|---|---|
| `loaders/account/profile` | Admin `GET /customers/<id>` | Picks id/name/email/phone/identification/`billing_*`. |
| `actions/account/updateProfile` | Admin `PUT /customers/<id>` | Allow-list: name, phone, identification (CPF checked), `billing_*`. Never email/password/note. |
| `loaders/account/addresses` | Admin `GET /customers/<id>?fields=addresses,default_address` | `default` flag derived. |
| `actions/account/addAddress` | Admin `PUT /customers/<id>` `{addresses:[…]}` | The PUT **appends**. Country forced to BR. |
| `actions/account/updateAddress` | store form `POST /account/address/<id>/` (trailing slash required) | Admin PUT would create a duplicate. Success = 302 to `/account/addresses…`; rejected = 302 back to the form. |
| `loaders/account/orders` | Admin `GET /orders?customer_ids=<id>` | `page` clamped 1..1000, `perPage` 1..50. Empty = 404 "Last page is 0" → `[]`. |
| `loaders/account/order` | Admin `GET /orders/<id>?aggregates=fulfillment_orders` | |

Code: `utils/accountData.ts` (operations), `utils/account.ts` (validation, `AccountError`,
pt-BR error mapping), `utils/orders.ts` (mapping + status labels). `sessionCustomerId()`
(`store.ts`, exported from the barrel) is the only source of the customer id.
All loaders are `cache = "no-store"` and go through `nuvemshopAdmin` (raw instrumented
transport, **not** `createFetchCache`): per-user data must never hit the shared GET cache.
Errors are `AccountError` (`.status`, pt-BR message); a site's server-fn layer should
surface only those and keep everything else generic.

### Security rules (each is tested in `__tests__/accountData.test.ts`)

- The customer id comes from the session only (`LS.customer` on `/account/`), never props. No session → 401, nothing sent to the Admin API.
- The scrape fails closed: every `LS.customer = N;` in the page must agree (user text rendered in the page can't override it).
- Ids from callers (`orderId`, `addressId`) go through `parseId` (digits only, safe integer > 0) before touching a URL.
- Ownership compares `String(a) === String(b)`; not-yours is the same 404 as not-found (same message, one upstream call).
- `orders` is post-filtered by `customer.id` regardless of the upstream filter; address updates only accept ids from the session customer's own list.
- Writes are allow-listed field by field; extra keys (`id`, `customer_id`, `email`) are dropped.
- **Same-origin / CSRF is the site's job** (server-fn layer): reject cross-origin browser requests (`Sec-Fetch-Site` not `same-origin`/`none`, or `Origin` host ≠ request host), set `Cache-Control: private, no-store`, and map errors. The package has no request-origin policy.

### Unsupported (no upstream support)

- Address delete / set default: neither the Admin API nor the store form exposes them.
- Logged-in password change: no endpoint.
- Password recovery: the store form needs a reCAPTCHA bound to the store domain.

### Client bundles

`admin.ts` carries no secrets itself (the token is read from server config at call time), but
the barrel (`index.ts`) re-exports server-only code (`store.ts`, loaders). Import loaders/actions
from server code (invoke/server fns) — never from client components.
