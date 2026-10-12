# Accounts: register, login, logout, user

No API covers customer sessions. What works, validated against a live store:

| Action | Upstream | Notes |
|---|---|---|
| `actions/account/register` | Admin API `POST /customers` `{name,email,password,send_email_invite:false}` | The store's form needs a reCAPTCHA bound to its domain — posting it without the token is **silently rejected** (302 back, no account). The Admin API has no captcha, so the action requires Cloudflare Turnstile (`turnstileSecret`) unless `allowUnverifiedRegistration` (demos). Duplicate email → 422 → `email_taken`. |
| `actions/account/login` | store `POST /account/login/` (email, password) | Success = 302 to `/account/`. Failure = 302 back to the login page, whose HTML carries the reason: `js-login-general-error` (wrong credentials) or `js-account-validation-pending` (email not validated — every new account must click the email link first). The page also contains hidden copies of every message, so match the class, not the text. |
| `actions/account/logout` | store `GET /account/logout/` | |
| `loaders/user` | store `GET /account/` → `LS.customer = <id>`; Admin API `GET /customers/<id>` | `null` when there's no `store_*` cookie or `/account/` redirects to login. |

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
