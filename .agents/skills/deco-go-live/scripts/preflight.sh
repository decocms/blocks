#!/usr/bin/env bash
# Read-only go-live preflight for a site on @decocms/blocks 8 (TanStack Start
# behind createDecoWorker; most repo checks also make sense on Next.js).
#
# Usage: preflight.sh <site-repo-dir> [candidate-url] [old-site-url]
#   site-repo-dir  the site repo (static checks)
#   candidate-url  https://host serving the new site (HTTP checks)
#   old-site-url   https://host serving the old site (header diff)
# Env: CHECKOUT_PATH (default /checkout/)
#
# Prints PASS / WARN / FAIL per check and never writes anything. It runs no
# deco command: run `deco schema --check` and `deco check` yourself.
# Browser-only checks (marked 🧪 in SKILL.md) are not covered.

set -u
REPO="${1:?usage: preflight.sh <site-repo-dir> [candidate-url] [old-site-url]}"
CAND="${2:-}"; CAND="${CAND%/}"
OLD="${3:-}"; OLD="${OLD%/}"
CHECKOUT="${CHECKOUT_PATH:-/checkout/}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36"

fails=0; warns=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; warns=$((warns + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }
show() { sed 's/^/         /' | head -n "${1:-5}"; }
section() { printf '\n== %s\n' "$1"; }

SRC="$REPO/src"
[ -d "$SRC" ] || SRC="$REPO"
# grep the site's source, skipping generated, vendored and test files and comment lines
g() {
  grep -rnE "$@" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.deco --exclude-dir=.git \
    --exclude-dir=.output --exclude-dir=.next \
    --exclude='*.gen.ts' --exclude='*.test.*' --exclude='*.spec.*' "$SRC" 2>/dev/null |
    grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)'
}

WRANGLER=""
for f in wrangler.jsonc wrangler.json wrangler.toml; do [ -f "$REPO/$f" ] && WRANGLER="$REPO/$f" && break; done

section "Packages and content (references/content-releases.md)"

if [ -f "$REPO/package.json" ]; then
  v=$(grep -oE '"@decocms/blocks"\s*:\s*"[^"]+"' "$REPO/package.json" | head -1)
  case "$v" in
    *'"^8'* | *'"8'* | *'"~8'* | *'workspace:'*) pass "@decocms/blocks: ${v#*: }" ;;
    "") fail "@decocms/blocks is not a dependency" ;;
    *) warn "@decocms/blocks ${v#*: }: this skill is for v8" ;;
  esac
fi

hits=$(g 'createDecoWorkerEntry|@decocms/start|registerSections|registerCachePattern|createCachedLoader|/deco/invoke|DECO_FAST_DEPLOY')
if [ -z "$hits" ]; then pass "no v7 runtime APIs in source"
else fail "v7 APIs left in source (see deco-v7-to-v8-migration)"; echo "$hits" | show 8; fi

if [ -f "$REPO/.deco/schema.gen.json" ]; then
  if grep -qE '"blocksMajor"\s*:\s*8' "$REPO/.deco/schema.gen.json"; then pass 'schema.gen.json has "blocksMajor": 8'
  else fail 'schema.gen.json lacks "blocksMajor": 8: Studio edits the site as v7 and deco check fails'; fi
else warn "no .deco/schema.gen.json: run deco schema and commit it"; fi

files=$(g 'createCMS(<[^>]*>)?\(' | cut -d: -f1 | sort -u)
if [ -z "$files" ]; then warn "createCMS not found in source"
else
  # the createCMS({ ... }) call itself, comments dropped
  call=$(for f in $files; do awk '/createCMS(<[^>]*>)?\(/{f=1} f{sub(/\/\/.*/, ""); print} f&&/\}\)/{f=0}' "$f"; done)
  if echo "$call" | grep -qE '(^|[^A-Za-z_.])site\s*[:,}]'; then pass "createCMS has site: releases come from the CDN"
  else warn "createCMS without site: content is bundled and every content change needs a deploy"; fi
fi

hits=$(g "\.deco/blocks/[^\"']+\.json")
[ -z "$hits" ] && pass "no direct imports of .deco/blocks/*.json" ||
  { warn "direct imports of saved blocks: a publish never reaches them"; echo "$hits" | show; }

section "Worker runtime (references/worker-runtime.md)"

if g 'createDecoWorker(<[^>]*>)?\(' >/dev/null; then pass "createDecoWorker in source"
else warn "no createDecoWorker in source (fine on Next.js; on TanStack the worker features are missing)"; fi

hits=$(g 'new QueryClient\(')
if [ -z "$hits" ]; then pass "no QueryClient"
elif echo "$hits" | grep -q 'router.tsx' && awk '/getRouter/{f=1} f&&/new QueryClient\(/{found=1} END{exit !found}' "$SRC/router.tsx" 2>/dev/null; then
  pass "new QueryClient() appears after getRouter in router.tsx (confirm it is not at module scope)"
else fail "new QueryClient() possibly at module scope: it leaks data between users"; echo "$hits" | show; fi

hits=$(g '^(export )?(const|let) [A-Za-z_]+ = new (Map|Set)\(')
[ -z "$hits" ] && pass "no module-level Map/Set" ||
  { warn "module-level Map/Set: must hold only data that is the same for every user, with deadlines on shared promises"; echo "$hits" | show; }

if [ -n "$WRANGLER" ]; then
  if grep -qE '"?observability"?' "$WRANGLER" && grep -A2 -E '"?observability"?' "$WRANGLER" | grep -q 'true'; then
    pass "Workers observability enabled"
  else warn "observability not enabled in $(basename "$WRANGLER"): exceededMemory and canceled are invisible"; fi
  mem=$(grep -oE '"?memory_mb"?\s*[:=]\s*[0-9]+' "$WRANGLER")
  [ -n "$mem" ] && warn "custom memory limit ($mem): a stopgap; find what fills memory"
fi

hits=$(g '\.text\(\)' | grep -iE 'sitemap|proxy|upstream|checkout')
[ -z "$hits" ] && pass "no .text() buffering in sitemap/proxy code" ||
  { warn "large responses buffered with .text(): stream them"; echo "$hits" | show; }

n=$(g 'AbortSignal\.timeout' | wc -l | tr -d ' ')
[ "$n" = "0" ] && warn "no AbortSignal.timeout in source: upstream fetches have no deadline" || pass "$n upstream deadline(s) (AbortSignal.timeout)"

if g 'telemetry\s*:|token\s*:' | grep -q .; then pass "telemetry options present (confirm token or endpoint is set in production)"
else warn "no telemetry option seen: request and upstream metrics go nowhere"; fi

section "Cache (deco-storefront-caching)"

if g 'pageCache' >/dev/null; then pass "pageCache passed to the worker"
else warn "no pageCache: every request renders (fine only if a CDN in front caches pages)"; fi

hits=$(g '\.catch\(\(\)\s*=>\s*(null|undefined|\[\])\)' | grep -viE 'cache\.(match|put|delete)')
[ -z "$hits" ] && pass "no errors swallowed to null" ||
  { warn "errors swallowed to null: may be cached as not-found or out-of-stock (use DEGRADED_HEADER)"; echo "$hits" | show; }

section "Traffic split (references/traffic-ramp.md)"
if g 'abTestingRoutes' >/dev/null; then
  pass "abTestingRoutes in use: test both buckets with ?_deco_bucket=worker|fallback"
  g 'shouldBypassAB' >/dev/null || warn "no shouldBypassAB: routes only the new site has will be split too"
else pass "no traffic split handler (skip if the cutover is a straight switch)"; fi

section "React / Fresh leftovers (references/react-spa.md)"

hits=$(g 'window\.STOREFRONT|window\.addToCart|hx-(post|get|on|trigger)')
[ -z "$hits" ] && pass "no Fresh global SDK / htmx leftovers" || { fail "Fresh/htmx leftovers"; echo "$hits" | show 10; }

hits=$(g 'on[A-Z][a-zA-Z]+=\{useScript')
[ -z "$hits" ] && pass "no on*={useScript(...)} handlers" || { fail "an event handler receives a string from useScript"; echo "$hits" | show; }

n=$(g 'useScript\(|useScriptAsDataURI\(' | cut -d: -f1 | sort -u | wc -l | tr -d ' ')
[ "$n" = "0" ] || warn "$n file(s) with useScript/useScriptAsDataURI: test each by SPA click; prefer inlineScript"

if ls "$REPO"/eslint.config.* "$REPO"/.eslintrc* "$REPO"/biome.json* >/dev/null 2>&1 &&
  grep -qE 'rules-of-hooks|useHookAtTopLevel' "$REPO"/eslint.config.* "$REPO"/.eslintrc* "$REPO"/biome.json* 2>/dev/null; then
  pass "hook-order lint configured"
else warn "no rules-of-hooks (ESLint) or useHookAtTopLevel (Biome): hooks after an early return cause React #310"; fi

g 'preloadError' >/dev/null && pass "stale-chunk handler present" ||
  warn "no vite:preloadError handler: open tabs break after each deploy"

if g 'createDecoRouter(<[^>]*>)?\(' >/dev/null && ! g 'defaultPreload' >/dev/null; then
  warn "createDecoRouter with the default defaultPreload \"intent\": measure the payload a hover fetches"
fi

section "Analytics (references/seo-analytics.md)"
g 'googletagmanager|GoogleTagManager|gtm\.js' >/dev/null && pass "tag manager referenced in source" ||
  warn "tag manager not referenced in source (injected elsewhere? not mounted?)"
hits=$(g 'requestIdleCallback|firstInteraction|onFirstGesture' | grep -iE 'gtm|tag|analytic')
[ -z "$hits" ] && pass "no gesture/idle gate around tags" ||
  { fail "tag manager gated behind a gesture or idle (about 20% of orders lost on one store)"; echo "$hits" | show; }
[ -f "$REPO/public/sitemap.xml" ] && warn "static public/sitemap.xml: it may mask a missing sitemap route"

if [ -n "$CAND" ]; then
  section "HTTP: candidate $CAND"
  cc() { curl -s -m 20 -A "$UA" "$@"; }
  code() { cc -o /dev/null -w '%{http_code}' "$@"; }
  # final status, skipping 103 Early Hints
  status() { grep -E '^HTTP/' | grep -v ' 103' | tail -1 | awk '{print $2}'; }

  [ "$(cc "$CAND/deco/_liveness")" = "OK" ] && pass "/deco/_liveness → OK (createDecoWorker in front)" ||
    warn "/deco/_liveness did not answer OK (not behind createDecoWorker?)"
  c=$(code "$CAND/live/_meta")
  [ "$c" = "404" ] && pass "v7 admin path /live/_meta → 404" || warn "/live/_meta → $c (expected 404 from the worker)"

  c=$(code "$CAND/")
  [ "$c" = "200" ] && pass "/ → 200" || fail "/ → $c"

  # the first-visit visitor cookie, the split cookie and Cloudflare's own are expected
  h=$(cc -o /dev/null -D - "$CAND/" | tr -d '\r')
  sc=$(echo "$h" | grep -i '^set-cookie:' | grep -viE '^set-cookie: *(deco_segment|_deco_bucket|__cf_bm|_cfuvid|cf_clearance)=')
  [ -z "$sc" ] && pass "anonymous / sets no cookie besides deco_segment" ||
    { warn "anonymous / sets other cookies: a page cache must not store it"; echo "$sc" | cut -c1-90 | show; }
  echo "$h" | grep -qi '^x-robots-tag:.*noindex' && fail "/ sends X-Robots-Tag noindex" || pass "/ has no X-Robots-Tag noindex"
  xc=$(cc -o /dev/null -D - "$CAND/" | tr -d '\r' | grep -iE '^(x-cache|cf-cache-status):' | tr '\n' ' ')
  echo "$xc" | grep -qi 'hit' && pass "2nd request: $xc" || warn "2nd request not a HIT: ${xc:-no cache header}"

  h=$(cc -o /dev/null -D - "$CAND/?__draft=off" | tr -d '\r')
  if echo "$h" | grep -qi '^cache-control: *max-age=0, no-cache, must-revalidate' && echo "$h" | grep -qi '^x-robots-tag:.*noindex'; then
    pass "?__draft= preview answers no-cache and noindex"
  else warn "?__draft=off did not answer the preview headers (worker not in front?)"; fi

  h=$(cc -o /dev/null -D - -H 'If-Modified-Since: Tue, 20 Oct 2026 00:00:00 GMT' -H 'If-None-Match: "x"' "$CAND$CHECKOUT" | tr -d '\r')
  c=$(echo "$h" | status)
  if [ "$c" = "304" ]; then fail "$CHECKOUT answers 304 to validators: stale checkout from the browser cache"
  elif echo "$h" | grep -qiE '^(last-modified|etag):'; then warn "$CHECKOUT sends Last-Modified/ETag: the browser will revalidate"
  else pass "$CHECKOUT → $c without validators"; fi
  coop=$(echo "$h" | grep -i '^cross-origin-opener-policy:' | cut -d: -f2- | xargs)
  [ -n "$coop" ] && warn "$CHECKOUT sends Cross-Origin-Opener-Policy: $coop (compare with the old site)"

  loops=""
  for p in '/%7Bx%7D' '/x%7B' '/%5Bx%5D' '/%7Cx' '/%5Ex' '/%60x'; do
    n=$(cc -o /dev/null -L --max-redirs 10 -w '%{num_redirects}' "$CAND$p")
    [ "${n:-0}" -ge 5 ] && loops="$loops ${p};"
  done
  [ -z "$loops" ] && pass "no redirect loops on encoded paths" || fail "redirect loop (5+ hops) on:$loops"

  robots=$(cc "$CAND/robots.txt")
  echo "$robots" | grep -qE '^Disallow:\s*/\s*$' && fail "robots.txt has Disallow: /" || pass "robots.txt does not block everything"
  cc "$CAND/" | grep -qiE '<meta[^>]+robots[^>]+noindex' && fail "home has meta noindex" || pass "home indexable"
  cc "$CAND/" | grep -q 'googletagmanager.com' && pass "tag manager in home HTML" || warn "tag manager not in home HTML (host-gated? injected late?)"

  c=$(code "$CAND/this-page-should-not-exist-$RANDOM")
  [ "$c" = "404" ] && pass "missing page → 404" || fail "missing page → $c (soft 404)"

  if [ -n "$OLD" ]; then
    section "Header diff: old $OLD × candidate"
    for p in / "$CHECKOUT"; do
      for hdr in cross-origin-opener-policy cross-origin-embedder-policy content-security-policy permissions-policy x-frame-options referrer-policy strict-transport-security; do
        a=$(curl -s -m 20 -A "$UA" -o /dev/null -D - "$OLD$p" | tr -d '\r' | grep -i "^$hdr:" | cut -d: -f2- | xargs)
        b=$(cc -o /dev/null -D - "$CAND$p" | tr -d '\r' | grep -i "^$hdr:" | cut -d: -f2- | xargs)
        [ "$a" = "$b" ] || warn "$p $hdr: old='${a:-<none>}' candidate='${b:-<none>}'"
      done
    done
    pass "header diff done (differences listed above, if any)"
  fi
fi

printf '\n%s FAIL, %s WARN. Also run: deco schema --check && deco check. Browser checks (🧪) are in SKILL.md.\n' "$fails" "$warns"
[ "$fails" = "0" ]
