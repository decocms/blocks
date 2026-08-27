#!/usr/bin/env tsx
/**
 * Generate (and optionally apply) the Cloudflare Cache Rules that let the CDN
 * serve deco storefronts without invoking the Worker.
 *
 * ## Why this is generated and not hand-written
 *
 * The Worker keys its edge cache on a SYNTHETIC Request carrying
 * `__seg`/`__cf_device`/`__cf_geo`/`__bot`/`__fetch`/`__abf` (`buildCacheKey`
 * in `@decocms/tanstack`). Cloudflare's CDN keys on the raw URL and ignores
 * `Vary` beyond `Accept-Encoding`. Every dimension the CDN cannot reproduce has
 * to become a bypass here — and each one corresponds to a constant on the
 * Worker side. Two hand-maintained copies of that list drift, and the failure
 * mode is not a slow page, it is one visitor being served another's response.
 * So the expressions below are DERIVED from the same constants the Worker uses.
 *
 * ## Division of labour
 *
 * The Worker stays the source of truth for *whether* a response may be cached:
 * private routes, logged-in requests, drafts and set-cookie responses already
 * go out with `CDN-Cache-Control: no-store`, and Cloudflare honours that. So
 * these rules deliberately do NOT enumerate private paths — a site adding
 * `registerPrivatePaths([...])` propagates to the CDN on its own.
 *
 * What the rules must cover is the narrower case the header cannot reach: when
 * the CDN answers from cache WITHOUT consulting the Worker, and would hand one
 * visitor an entry that belongs to another segment.
 *
 * ## Scoping in a shared zone
 *
 * Sites are custom hostnames under one deco zone (Cloudflare for SaaS), so a
 * rule applies to every site at once. Enablement therefore rides on per-hostname
 * custom metadata rather than a rule per site:
 *
 *   curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/custom_hostnames/$ID" \
 *     --request PATCH --header "Authorization: Bearer $TOKEN" \
 *     --json '{"custom_metadata": {"deco_cdn_html": "on"}}'
 *
 * Rolling out to a site is that PATCH; rolling back is setting it to "off".
 * Neither touches the ruleset.
 *
 * Usage:
 *   tsx scripts/cdn-rules.ts                  # print the ruleset as JSON
 *   tsx scripts/cdn-rules.ts --expression     # print just the bypass expression
 */

import { BOT_UA_SUBSTRINGS } from "@decocms/blocks/cms";
import { DECO_MATCHERS_OVERRIDE_PARAM } from "@decocms/blocks/matchers/override";
import { SEGMENT_COOKIE } from "@decocms/blocks/sdk/flags";

/** Metadata key read off the custom hostname to enable CDN caching per site. */
export const CDN_ENABLED_METADATA_KEY = "deco_cdn_html";

/**
 * Auth cookie names that mean "this visitor must never be served a shared CDN
 * entry". VTEX sets both the bare name and an account-suffixed variant
 * (`VtexIdclientAutCookie_<account>`); matching on the prefix covers both.
 */
export const AUTH_COOKIE_PREFIXES = ["VtexIdclientAutCookie"];

const enabled = `lookup_json_string(cf.hostname.metadata, "${CDN_ENABLED_METADATA_KEY}") eq "on"`;

/**
 * Requests that must never be served from a shared CDN entry.
 *
 * Each clause is annotated with the `buildCacheKey` dimension it mirrors. If
 * you add a dimension to the cache key, it belongs here too.
 */
export function bypassExpression(): string {
  const clauses = [
    // Worker key: no equivalent — an authenticated visitor would otherwise be
    // served the cached anonymous entry without the Worker ever running. This
    // is the single most important clause in the file.
    ...AUTH_COOKIE_PREFIXES.map((name) => `http.cookie contains "${name}"`),

    // Worker key: `__abf` — the sticky A/B cohort cookie.
    `http.cookie contains "${SEGMENT_COOKIE}="`,

    // Worker key: `__bot` — bots render every section eagerly (~10x payload).
    `lower(http.user_agent) matches "${BOT_UA_SUBSTRINGS.join("|")}"`,

    // Worker key: `__fetch` — programmatic fetches also render eagerly.
    'http.request.headers["sec-fetch-dest"][0] eq "empty"',

    // Worker: `isCacheable()` bypasses these outright. Duplicated here so a
    // draft never depends on the response header alone.
    'http.request.uri.query contains "__draft="',
    'http.request.uri.query contains "__deco_preview"',
    'http.request.uri.query contains "pathTemplate"',
    `http.request.uri.query contains "${DECO_MATCHERS_OVERRIDE_PARAM}"`,
    `any(http.request.headers.names[*] eq "${DECO_MATCHERS_OVERRIDE_PARAM}")`,
    'http.cookie contains "__deco_draft"',
  ];

  return `(${enabled}) and (${clauses.join(" or ")})`;
}

/**
 * The ruleset, in the order Cloudflare evaluates it: bypass first, then cache
 * everything else keyed by device.
 *
 * Note what is NOT set here: the edge TTL. `respect_origin` keeps the TTL
 * coming from the `CDN-Cache-Control` the Worker already derives per cache
 * profile, so the profile table stays in one place.
 */
export function cacheRuleset() {
  return {
    rules: [
      {
        description: "deco: bypass CDN for segment-sensitive requests",
        expression: bypassExpression(),
        action: "set_cache_settings",
        action_parameters: { cache: false },
      },
      {
        description: "deco: cache by device type, TTL from origin",
        expression: `(${enabled})`,
        action: "set_cache_settings",
        action_parameters: {
          cache: true,
          cache_key: { cache_by_device_type: true },
          edge_ttl: { mode: "respect_origin" },
        },
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expressionOnly = process.argv.includes("--expression");
  console.log(expressionOnly ? bypassExpression() : JSON.stringify(cacheRuleset(), null, 2));
}
