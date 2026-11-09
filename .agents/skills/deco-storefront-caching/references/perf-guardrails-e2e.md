# Playwright guardrails for cache and payload

Cache and egress gains regress quietly: one cookie in a section, one new query param, one product
object passed whole to a card. A Playwright spec that runs on every PR catches them. It works over
HTTP, so it tests the site as a visitor sees it. For the harness itself (config, fixtures, CI
setup) see `deco-e2e-testing` in decocms/skills.

## Where to run it

`pageCache` does not run in `vite dev`. Run the spec against a build:

```json
{
  "scripts": {
    "e2e:serve": "vite build && vite preview --port 4173 --strictPort",
    "e2e:perf": "playwright test tests/e2e/perf-guardrails.spec.ts"
  }
}
```

Set `use.baseURL` to `http://127.0.0.1:4173` and `webServer.command` to `npm run e2e:serve` (or
`bun run e2e:serve`) in `playwright.config.ts`. Against a preview deployment, point `baseURL`
there instead; that also exercises the real Cache API.

Read expected header values from your worker entry's profiles instead of copying numbers into the
spec. If `PROFILES` and `browserCacheControl` are exported from a module the spec can import,
the spec follows a TTL change instead of failing on it.

## What to assert

| Area | Assertion |
|---|---|
| Profiles | Each representative path answers the `Cache-Control` of its profile; the second request is `x-cache: HIT` |
| Private paths | `/cart`, `/checkout`, account pages: `private, no-cache, no-store, must-revalidate`, `x-cache: BYPASS` |
| Previews | `?__draft=off`: `max-age=0, no-cache, must-revalidate`, `vary` has `Cookie`, `x-robots-tag` has `noindex`, no `x-cache` |
| Signed-in shopper | The sign-in cookie gives `x-cache-reason: private` |
| Returning visitor | A cart or checkout cookie alone does not make the page private |
| Tracking params | `utm_*`, `gclid`, `fbclid`: 200, no `location`, same `x-cache-segment`, HIT once warm |
| No poisoning | A value sent in `gclid` never appears in the clean URL's HTML |
| No cookies on cached pages | A public page answers no `set-cookie` except `deco_segment` on a first visit |
| Payload | Raw HTML under a budget; a marker of heavy data (a schema.org type you trim) under a count |
| Assets | A fingerprinted asset is `public, max-age=31536000, immutable` |
| CLS | Home and a listing under 0.1 on desktop and mobile |

## Spec sketch

```ts
import { expect, test } from "@playwright/test";

const LISTING = "/some-category";
const get = (request, path, headers = {}) =>
  request.get(path, { headers, maxRedirects: 0 });

test("listing is stored and served from the cache", async ({ request }) => {
  await get(request, LISTING);
  const res = await get(request, LISTING);
  expect(res.headers()["x-cache"]).toBe("HIT");
  expect(res.headers()["x-cache-profile"]).toBe("listing");
  expect(res.headers()["cache-control"]).toContain("public");
});

test("tracking params share the clean entry and never leak", async ({ request }) => {
  const clean = await get(request, LISTING);
  const tagged = await get(request, `${LISTING}?utm_source=g&gclid=POISON42&fbclid=f`);
  expect(tagged.status()).toBe(200);
  expect(tagged.headers()["location"]).toBeUndefined();
  expect(tagged.headers()["x-cache-segment"]).toBe(clean.headers()["x-cache-segment"]);
  const after = await get(request, LISTING);
  expect(await after.text()).not.toContain("POISON42");
});

test("a preview is never cached", async ({ request }) => {
  const res = await get(request, "/?__draft=off");
  expect(res.headers()["cache-control"]).toBe("max-age=0, no-cache, must-revalidate");
  expect(res.headers()["x-cache"]).toBeUndefined();
});

test("a returning visitor's cart cookie does not make the page private", async ({ request }) => {
  const res = await get(request, "/", { cookie: "<cart-cookie>=x" });
  expect(res.headers()["x-cache-reason"]).not.toBe("private");
});

test("listing HTML stays under budget", async ({ request }) => {
  const body = await (await get(request, LISTING)).text();
  expect(body.length).toBeLessThan(BUDGET.listingRawBytes);
  expect((body.match(/UnitPriceSpecification/g) ?? []).length).toBeLessThan(BUDGET.priceSpecs);
});
```

`x-cache` is per data center on a real deployment and per process on `vite preview`. Run the
warm-up request and the assertion from the same runner.

## Probes worth keeping as scripts

**Visitor-profile fingerprint.** For a few listings, request the page with a set of profiles that
must see the same content: no cookies, the platform's segment cookie with only marketing fields,
tracking params in the URL, a test-bucket cookie on the same side. Fingerprint the ordered product
ids and fail on any mismatch. When one profile differs, the key or the segment is reading
something that does not change the content, or the content reads something the key misses.

**Empty upstream.** Give the loader a switch, off in production, that makes its upstream call
return `null` (an env variable or a test-only build flag). With the switch on, the page must answer `x-cache: BYPASS` with
`x-cache-reason: degraded`, twice in a row. With it off, the next request must render the full
page. This catches the most expensive bug in this skill: an empty page stored as valid.

**Cache probe.** A table of path, status, raw KB, `x-cache` and time for home, a clean listing, a
tagged listing and a product page, after one warm-up. Run it against production once to set
budgets about 30% above what you see, and after each deploy as a smoke check. The tagged and clean
listings should be within a few percent of each other.

## Static checks

Grep the content for blocks that point at loaders you know bypass your trimming or caching (for
example a raw upstream search loader instead of the site's trimmed one). The content lives in
`.deco/blocks`; a test that greps it fails the PR before any request is made.

## CI

Run `e2e:perf` and the probes on every PR that touches the worker entry, a loader, a section on a
cacheable page, or the segment. A full run of about twenty tests takes seconds against a local
preview.
