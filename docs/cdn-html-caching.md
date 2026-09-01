# Caching HTML at the CDN

`/_serverFn` is already covered without touching zone config — the client carries a segment marker in the URL
(`sdk/cdnSegment`), which makes the URL a complete cache key. **HTML cannot do that**: the initial navigation is
a browser request with no hook to attach a marker to.

This document is about the remaining half.

## Why zone rules, and not Workers Cache

Workers Cache (`cache: { enabled: true }` in wrangler) is per-worker, config-as-code, and keys on the worker
version — all attractive. It still does not work for HTML, for one reason:

> **No per-request opt-out before Worker invocation exists.**

On a cache HIT the Worker does not run, so the `no-store` it would have emitted for a logged-in visitor never
exists — that visitor gets the anonymous entry. The documented alternatives don't close it:

| mechanism | why it fails here |
|---|---|
| `Vary: Cookie` | compared **verbatim**; every visitor's analytics cookies make a distinct entry, so the cache is dead on arrival |
| `Cache-Control: private` | stops *storing* the logged-in response, not *serving* the anonymous one already stored |
| per-entrypoint disable | all-or-nothing, not per-request |
| CF-injected headers (`cf-ipcountry`) in `Vary` | not supported |

Zone rules are the only layer that can decline **before** the Worker. That is exactly what a logged-in visitor
needs.

## Prerequisites, per site

Check these before enabling anything — the first two are hard blockers.

**1. The Worker must already be caching the HTML.** If `X-Cache` is `BYPASS`, a CDN layer changes nothing:
the Worker is emitting `no-store` on purpose and the CDN will honour it.

```
curl -sD- -o/dev/null https://<site>/ | grep -i '^x-cache'
```

A common cause is `x-cache-reason: private-set-cookie` — the response carries `Set-Cookie` outside the safe
list. Identifiers belong in a middleware that runs *after* the cache layer (see `propagateISCookies` in
`@decocms/apps-vtex`), not in the cached response body.

**2. Matcher granularity must not exceed key granularity.** The key can express country and region. A site
whose matchers discriminate by **city** or **coordinates** needs finer granularity than the key provides, and
enabling CDN caching there serves the wrong variant — *worse* than today, since the Worker at least evaluates
the matcher on every request.

```bash
grep -rho '"__resolveType":"website/matchers/[^"]*"' .deco/blocks/ | sort -u
```

**3. `buildSegment` must be wired**, or the logged-in bypass is inert and authenticated visitors share the
anonymous entry.

**4. Only the dimensions actually used should be in the segment.** Region in the segment on a site with no
regional content splits every URL into ~27 buckets holding identical HTML — each warming separately, each miss
a round trip to the origin.

## Generating the rules

```bash
tsx node_modules/@decocms/blocks-cli/scripts/cdn-rules.ts        # device only
tsx node_modules/@decocms/blocks-cli/scripts/cdn-rules.ts --geo  # + country/region in the key
```

Two rules, **mutually exclusive by expression** rather than by order — Cloudflare's cache phase is
last-match-wins, so a catch-all listed after a bypass silently overrides it.

The expressions are derived from the Worker's own constants (`SEGMENT_COOKIE`, `BOT_UA_SUBSTRINGS`,
`DECO_MATCHERS_OVERRIDE_PARAM`). Two hand-maintained copies drift, and the failure mode is one visitor being
served another's response.

Note what the rules deliberately do **not** contain: private paths. The Worker already emits `no-store` for
them and Cloudflare honours it, so `registerPrivatePaths([...])` propagates with no rule change.

## Enabling per site

Sites are custom hostnames in one shared zone, so a rule applies to every site at once. Enablement rides on
per-hostname metadata:

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/custom_hostnames/$ID" \
  --request PATCH --header "Authorization: Bearer $TOKEN" \
  --json '{"custom_metadata": {"deco_cdn_html": "on"}}'
```

Rollout and rollback are that PATCH. Neither touches the ruleset.

> Not yet verified: the docs confirm `cf.hostname.metadata` in the rules engines but do not state support
> inside Cache Rules specifically. Test it on one hostname before relying on it; the fallback is a rule per
> host with `http.host in {...}`.

## Verifying

Walk a real site — home, PLP, PDP, search, checkout, account, wishlist — logged in and anonymous, mobile and
desktop, with and without a bot user agent. Check `Cf-Cache-Status`, `X-Cache`, `X-Cache-Segment` and
`CDN-Cache-Control`.

The one that matters most: **log in, open an account page, and confirm the response never comes from the CDN.**
