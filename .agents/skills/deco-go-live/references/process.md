# Process: freeze, parity, cutover, first 72 hours

Most go-live pain was not code. It was code or content changing on the old
site while the new one was being validated, or a cutover step done in the
wrong order.

## Code freeze and reconcile

**What happened:** on one store the team kept shipping to the old repo after
the candidate was validated, and at cutover the new site was out of date. On
another there was no freeze for a month, and 4 to 5 features had to be pulled
out of commit history. After go-live, three old-repo PRs and an A/B variant
that was never ported still had to be ported.

- [ ] Agree a **freeze date** in writing: from that day until go-live, no code merges on the old repo.
- [ ] Record `FREEZE_SHA`: the old repo's `main` at the freeze.
- [ ] Reconcile every old-repo commit from the migration cut to `FREEZE_SHA` (the **tools-reconcile-snapshot** skill in decocms/migrations gives one diff per changed file). Port by hand. Skip generated files and saved content: content moves separately (below).
- [ ] After go-live, keep watching the old repo. Anything merged there is a port ticket.

```bash
git -C <old-repo> log --oneline <CUT_SHA>..origin/main -- . ':!.deco/blocks' ':!static'
```

## Content freeze and the last import

On v8 the content lives in Studio releases, served from the delivery CDN.
The old CMS keeps changing until someone stops it. An import done at 07:00
misses an edit published at 08:00.

- [ ] Agree a **content freeze** on the old CMS, and do the last import after the content team's last publish.
- [ ] Bring the imported blocks in as a draft, check it, then publish it:

```bash
deco push --draft=cutover           # saves the blocks changed since the pull; prints the preview link
deco check --draft=cutover          # the draft against .deco/schema.gen.json: 0 errors
deco publish --draft=cutover --message="cutover import"
deco releases                       # the new revision is "current"
```

- [ ] After go-live, the old CMS is read-only. A one-way sync that keeps running overwrites edits made in Studio. On one store a leftover sync overwrote 21 blocks edited in the new CMS.
- [ ] Fix content problems **in code at the seam** (a guard, a default, a cap) when the next import would bring the bad value back.

`deco push`, `pull`, `diff` and drafts are covered in **deco-site-workflow**.

## Structural parity (five criteria)

AI ports tend to rebuild components their own way. On one store, schemas were
changed, then the content import broke pages, because a component read the
same props differently on each side. Rule: **content stays the same and
components keep the interface they had in production.**

1. **HTML**: same landmarks, headings, `rel` and prefetch attributes, and the `data-*` attributes tags read.
2. **Schema**: same props, names, types and defaults. `deco schema`, then compare the Studio form with the old one (**deco-cms-schema**).
3. **Wiring**: every prop reaches the DOM; every `__resolveType` in `.deco/blocks` exists in the block map. `deco check` reports unknown types and broken references.
4. **Behavior**: open and close, add to cart, filters, forms, on desktop and mobile.
5. **Visual**: spacing, layout, icons, animation (pixel diff per section; **deco-make-editable** has the method).

For a v7 site, the parity harness and the list of approved differences are in
**deco-v7-to-v8-migration**.

## CMS pass

One hour with the people who edit the site, **before** go-live. The goal is
not training. Confirm that the props they edit are editable, the blocks they
pick still exist, and a draft preview works on the hosts they use (`deco
drafts url <name>` prints a draft's link).

## Inventory of what was not ported

- [ ] List integrations disabled or stubbed in the port (back-in-stock, try-on, chat, reviews) and get sign-off.
- [ ] List the A/B tests running on the old site (testing tools, search vendors). A variant whose code exists only on the old site must be ported or paused.
- [ ] Grep the old repo for inline behaviors (`hx-on:` handlers, inline scripts). Each one must exist in the port. On one store an unported `hx-on:click` left an empty box on every page.

## Cutover day

The safe pattern is a traffic split on the production host, not a switch of
DNS: the new worker takes every request and sends a share of visitors to the
old origin. Start at 0%, test the new bucket on the real domain, then ramp.
The v8 handler for this, and its traps, are in [traffic-ramp.md](./traffic-ramp.md).

1. **Deploy freeze** for the window. Each deploy changes the build hash, which moves every page-cache key (`cacheVersion`), and leaves open tabs with missing chunks ([react-spa.md](./react-spa.md#stale-chunks-after-deploy)).
2. **Split config first, then the route.** Write the KV entry for the host before the route sends traffic to the worker.
3. **Smoke with each bucket forced** (`?_deco_bucket=worker` and `?_deco_bucket=fallback`): home, listing, product, search, login, cart, checkout, old landing pages, redirects, `robots.txt`, sitemap, tag manager.
4. **Check the proxies** the site already has (checkout, `/api`, media) in both buckets.
5. **Warm the cache** by fetching **pages** with a mobile and a desktop user agent, for the top URLs from analytics. Warming loaders does not warm HTML.
6. **Traffic ladder** with written gates: 1% → 10% → 50% → 100%. At each step compare errors, `X-Cache` hit rate, 5xx rate, memory, and conversion per bucket.
7. **Rollback** written down and rehearsed for each layer: traffic, code, content ([content-releases.md](./content-releases.md#rollback)).

```bash
# warm-up: pages, both devices
while read -r path; do
  for ua in "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" \
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/139 Safari/537.36"; do
    curl -s -o /dev/null -A "$ua" -w "%{http_code} %{time_total}s $path\n" "https://$HOST$path"
  done
done < top-urls.txt
```

## First 72 hours

- Compare each metric with the **same hour the day before on the old site**, not with earlier the same day. Traffic shape changes by hour.
- When you remove an endpoint (telemetry, a beacon), keep it answering for at least the HTML cache TTL. Cached pages still call it.
- Feature flags: deploy the code that reads the new default first, then remove the old flag value.
- Path-filter CI jobs that run on every PR against a preview. One store's per-PR perf job cost 3,300 CI minutes a month and was deleted.
- Check each analytics vendor's own report against the same day last week ([seo-analytics.md](./seo-analytics.md#vendors-that-stop-silently)).
- Keep porting old-repo drift (see the freeze above).
