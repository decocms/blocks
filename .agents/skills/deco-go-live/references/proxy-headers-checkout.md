# Proxy, headers and checkout

The worker sits in front of everything: store pages, a proxied checkout,
`/api`, media and, during the ramp, the old site. A header the new stack adds
or a proxy that behaves differently shows up as lost conversion, not as an
error. Always compare with the old site.

On v8 the framework ships no commerce proxy. A proxied checkout is the site's
own code in `createDecoWorker({ routes })`. What the worker does to every
response on the way out still applies to it:

- On an HTML response, it sets each of its security headers **only when the response has none**: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-XSS-Protection`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and a `Content-Security-Policy` with Studio's origins in `frame-ancestors` and `script-src` (no `X-Frame-Options`).
- It sets `CDN-Cache-Control: no-store` on any response that names none.
- It keeps one `Set-Cookie` per cookie (name, Domain and Path).
- A `routes` response gets no `preload` hints.

## Header diff against the old site

**What happened:** the v7 TanStack worker sent `Cross-Origin-Opener-Policy:
same-origin-allow-popups` on all HTML; the proxied checkout had none and the
old Fresh site never sent COOP. Every store → checkout navigation switched
browsing-context group: popups lost `window.opener`, `window.name` was wiped,
and WebKit reset its timing clock. v8 sends the same default.

Fix: set the header yourself on the responses that must not carry it. The
worker never overwrites a header the response already has.

```ts
// in your routes proxy, on the proxied checkout's response
const out = new Response(upstream.body, upstream);
out.headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
return out;
```

For pages the app renders, set it in the route's `headers` (they reach the document response). If the
old site sent no COOP anywhere, decide it once for the whole site.

```bash
for host in "$OLD" "$CANDIDATE"; do
  for p in / /checkout/; do
    echo "== $host$p"
    curl -sI -A "Mozilla/5.0 Chrome/139" "$host$p" \
      | grep -iE "cross-origin|content-security|permissions-policy|x-frame|referrer-policy|strict-transport"
  done
done
```

Any header the new stack adds that the old one did not is a parity risk on
same-origin navigations to proxied pages. The CSP is also the site's: pass it
as `createDecoWorker({ csp: { enforce, reportOnly, frameAncestors } })`
(**deco-tanstack-site**). Start with `reportOnly` if the old site had none.

## Checkout HTML, 304 and bfcache

**What happened (two rounds):**

1. A proxy forced `private, no-store` on the checkout HTML, so it was never restored from bfcache. "Back" reloaded in 3 to 10 s, lost the coupon or card, and fired the tag-manager steps again.
2. Relaxing it to `private, no-cache, max-age=0, must-revalidate` made the browser store the HTML **with the platform's `Last-Modified`**. The next visit sent `If-Modified-Since`, the proxy passed it on, the platform answered 304, and the browser rendered a stale checkout. Anonymous conversion dropped from 28.8% to 23.8%.

Fix: on `GET` of the checkout paths, strip `If-Modified-Since` and
`If-None-Match` before proxying, and delete `Last-Modified` and `ETag` from the
checkout HTML. Keep `CDN-Cache-Control: no-store` (the worker's default).

```bash
curl -sD- -o /dev/null -A "Mozilla/5.0 Chrome/139" \
  -H "If-Modified-Since: Tue, 20 Oct 2026 00:00:00 GMT" "$CANDIDATE/checkout/" \
  | grep -iE "^HTTP|last-modified|etag|cache-control"
# expect 200, no Last-Modified, no ETag
```

🧪 bfcache: DevTools → Application → Back/forward cache on the checkout, **on
a deployed preview**. A dev server's proxy may bypass the worker. In the
browser, `performance.getEntriesByType('navigation')[0].transferSize` of about
300 bytes means a 304 was reused.

Large proxied bodies: stream them (`new Response(upstream.body, upstream)`);
never `await upstream.text()` on a whole page ([worker-runtime.md](./worker-runtime.md#memory-128-mb-per-isolate)).

## Third-party checkout scripts

**What happened:** an inline shim fixed a JS error in a store's custom
checkout script. Unblocking that code path made a broken call post
`marketingData` and **remove the coupon**, and an order-form patch made a
payment guard swallow "place order". The old site never reached that code,
because the error stopped it first.

- Errors that also happen on the old site may be load-bearing. In checkout, parity beats correctness.
- Byte-compare the proxied checkout HTML, old against new, and list every injected inline script. Put each injection behind a flag you can turn off.
- Measure payment-method pick → transaction on both stacks before blaming the migration.
- A third party that posts the order form's marketing data replaces the whole object. Read, merge, then write, so UTMs and your own tags survive.
- Never `<link rel=prefetch>` a third-party script that the next page loads with `crossorigin`. A cache mismatch stopped one checkout from mounting for about 2 hours.
- Store cart and checkout must share the same order-form cookie.

```bash
strip() { sed -E 's/[0-9a-f]{8,}//g; s/[0-9]{10,}//g'; }
diff <(curl -s "$OLD/checkout/" | strip) <(curl -s "$CANDIDATE/checkout/" | strip) | head -50
```

## Bugs that only exist on the real host

Previews on a `workers.dev` or preview domain miss them.

| Symptom | Root cause |
|---|---|
| server-side calls to `https://www.<domain>` hit the old site | a Worker's fetch to its own public hostname does not run the Worker again; it goes to the zone's origin |
| tags or analytics behave differently in production | tags gated on the hostname |
| a Studio draft link shows the release on the real host | drafts preview only on the hosts in the release's `previewHosts` (Studio writes them) plus `createCMS({ preview: { hosts } })`; any other host gets the release |

```bash
grep -rn "https://www\.<domain>" src        # server-side self-fetch, host checks
```

For every hit of the domain in `src/`, ask: what changes when the host **is**
this one? Test with the production `Host` before the route goes live.

## Self-redirect loop on encoded paths

**What happened on v7 TanStack sites:** the router compared the request's
path with the one it would build and redirected on a mismatch. Braces were not
re-encoded, so `/{x}` → 307 `/{x}` → the browser re-encodes → loop
(`ERR_TOO_MANY_REDIRECTS`, ~17k 307s a day from one login modal's
`<img src="{{qRCodeUrl}}">`). The v8 worker adds no guard for this. If the
fuzz below loops, answer such paths with a 404 in `routes`, before the router.

```bash
for p in '/%7Bx%7D' '/x%7B' '/foo-%7Bx%7D-1/p' '/%5Bx%5D' '/%7Cx' '/%5Ex' '/a%20b'; do
  curl -s -o /dev/null -L --max-redirs 10 -A "Mozilla/5.0 Chrome/139" \
    -w "$p %{http_code} hops=%{num_redirects}\n" "$CANDIDATE$p"
done   # 5 or more hops (or curl error 47) is a loop
```

It is not only braces: `^` also looped on one store. Fuzz every character the
router may decode and not re-encode.

## Requests the worker answers itself

- `/deco/_liveness` answers `OK`. Use it for uptime checks, not `/`.
- `/deco/*`, `/live/*` and `/.decofile` answer 404 (v7's admin paths). Old tooling or monitors that call them see 404s; update them. During a ramp this also affects the old site ([traffic-ramp.md](./traffic-ramp.md#traps)).
- A page request with `Authorization` answers `Cache-Control: private, no-cache, no-store, must-revalidate`, whatever the app set.
