# Audit 2 + 6 — VTEX auth cookie headers and HttpOnly handling

## Auth Cookie Headers

All authenticated VTEX IO GraphQL calls need both cookie variants:

```
VtexIdclientAutCookie={token}; VtexIdclientAutCookie_{account}={token}
```

**Implementation** (`vtexId.ts`):

```typescript
const VTEX_AUTH_COOKIE = "VtexIdclientAutCookie";
export { VTEX_AUTH_COOKIE };

export function buildAuthCookieHeader(authCookie: string, account: string): string {
  if (authCookie.includes("=")) return authCookie;
  return `${VTEX_AUTH_COOKIE}=${authCookie}; ${VTEX_AUTH_COOKIE}_${account}=${authCookie}`;
}
```

A value that already contains `=` passes through **unchanged** — a formatted header holding only `VtexIdclientAutCookie_{account}=…` does not gain the unsuffixed variant. Formatted inputs must already carry both cookies; normalize suffixed-only strings with `ensureUnsuffixedAuthCookie` (`utils/cookies.ts`, as `actions/address.ts` does) first.

**Use the centralized helper**:

```typescript
import { buildAuthCookieHeader, VTEX_AUTH_COOKIE } from "../utils/vtexId";
import { getVtexConfig } from "../client";

const { account } = getVtexConfig();
const cookieHeader = buildAuthCookieHeader(authCookie, account);
// Pass as: { cookie: cookieHeader } or { Cookie: cookieHeader }
```

Files that use this pattern:
- `actions/address.ts` — gql helper
- `actions/misc.ts` — gql helper
- `actions/newsletter.ts` — gql helper
- `actions/orders.ts` — cancelOrder
- `actions/profile.ts` — gql helper
- `actions/wishlist.ts` — buildCookieHeader
- `actions/session.ts` — deleteSession
- `utils/enrichment.ts` — simulation auth

Files that use `VTEX_AUTH_COOKIE` directly (as header name, not cookie):
- `actions/misc.ts` — submitReview sends `{ [VTEX_AUTH_COOKIE]: authCookie }` as HTTP header (Reviews API quirk)

**Audit**: grep for hardcoded `VtexIdclientAutCookie` strings. Only `vtexId.ts` should define it.

```bash
rg "VtexIdclientAutCookie" packages/apps-vtex/src/ --glob '!**/utils/vtexId.ts'
```

Any match outside `vtexId.ts` (except JSDoc comments) is a bug. (Cookie *parsers* such as `utils/cookieSanitizer.ts`, `utils/cookies.ts`, `utils/authHelpers.ts` legitimately match the cookie name in a regex or comment — judge each hit, don't just count them.)


## HttpOnly Cookies

`VtexIdclientAutCookie` is HttpOnly — **cannot** be read via `document.cookie`.

**Wrong**: Client-side hooks checking `document.cookie` for auth status.
**Correct**: `useUser` fetches `/api/sessions?items=profile.email` from the browser with `credentials: "include"` — the browser attaches the HttpOnly cookie itself, so JS never has to read it.

```typescript
// useUser.ts — correct pattern
async function fetchUser(): Promise<VtexUser> {
  const res = await fetch(
    "/api/sessions?items=profile.email,profile.firstName,profile.lastName,profile.id",
    { credentials: "include" },
  );
  // Parse session response for user data
}
```


## Fix: Header uses string instead of constant

```typescript
// Before
headers: { VtexidClientAutCookie: authCookie }
// After
import { VTEX_AUTH_COOKIE } from "../utils/vtexId";
headers: { [VTEX_AUTH_COOKIE]: authCookie }
```
