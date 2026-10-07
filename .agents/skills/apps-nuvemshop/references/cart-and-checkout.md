# Cart and checkout

## What exists

- **API**: `POST /checkouts {line_items, coupon_code?}` → `checkout_url`
  (`actions/createCheckout`). No cart, no totals/coupon preview before it.
- **Classic (theme) endpoints**, form-urlencoded + `X-Requested-With`, no CSRF:
  - add: `POST /comprar/` `add_to_cart=<productId>&variation[i]=<value>&quantity=N`
    (variant *values*, not the variant id) → `{success, item, cart}`;
  - change/remove: `POST /cart/update/` `quantity[<lineId>]=N` (0 removes);
  - read: `POST /cart/update/` with no body is `400 empty_quantities`; a
    non-existent line (`quantity[1]=1`) returns the cart unchanged; no cart →
    `400 cart_not_found`;
  - coupon: `POST /cart_coupon/` `coupon_code` (`400 coupon_not_found`),
    `/cart_coupon_remove/`; shipping: `/cart/save_shipping/`.
  - Session = `store_session_payload_<id>` + `store_login_session`
    (`store_cart_session_<id>` alone isn't enough).

## The `/comprar/` IP block

~15 carts created from one IP in a few minutes got that IP a `403
{"success":false}` on every add-to-cart — application-level, not a Cloudflare
challenge, including a real browser clicking the theme's button, for 35+ min.
No merchant setting changes it. A server-side proxy sends every buyer through
the Worker's egress IPs, so this can block a whole store's add-to-cart. The
API path (`/checkouts` with a Storefront token + buyer IP) doesn't have this.
Ask Nuvemshop before shipping a classic-cart proxy.

## Checkout proxy (spike)

Proxying `/checkout/*` (and the cart endpoints) to the store with `Set-Cookie`
`Domain` and `Location` rewritten renders the hosted checkout on our domain
identically to the store's own (contact → CEP → address → shipping → payment);
its API (`checkout-api.ms.tiendanube.com`) echoes any CORS origin with
credentials. Console warnings (checkout-security postMessage, report-only CSP,
Turnstile) appear on the store's own domain too. Payment itself was not
exercised (demo store without an active gateway).
