/**
 * Test-only. v7's own page-request code for the framework subpaths' tests
 * (`/tanstack`, `/nextjs`), from `src/__fixtures__/v7` (latest 7.x):
 *
 * - `v7Page`: a page's random rules through cms/resolve.ts'
 *   `evaluateVariantRule`, then the TanStack page route's `persistFlags`
 *   (verbatim, through h3's `setCookie`), as v7 served the page;
 * - `v7CacheToken`: the A/B token of v7's worker cache key (its
 *   `readRequestCookie`, verbatim);
 * - `v7Device`: sdk/useDeviceContext.tsx, with the request scope stubbed.
 *
 * And the generated pages and cookies both tests feed them.
 */
import * as React from "react";
import { vi } from "vitest";
import {
  decideRandom,
  type MatcherInput,
  SEGMENT_COOKIE,
  type StoredFlag,
} from "../matchers/index.ts";
import { noop, v7Loader, v7Source } from "./loadV7";
import { pick, rng } from "./v7";

let savedBlocks: Record<string, unknown> = {};
let v7Response = new Headers();

/** v7's request scope, which its `useDevice` read on the server. */
export const v7Runtime: { current: { request: Request } | null } = { current: null };

const v7 = v7Loader({
  stubs: {
    "cms/loader": { loadBlocks: () => savedBlocks },
    "cms/sectionLoaders": noop,
    "sdk/requestContext": { RequestContext: v7Runtime },
    react: React,
    "tanstack/routes/__h3": {
      // h3's setCookie: one Set-Cookie per cookie, the last one wins.
      setCookie: (name: string, value: string, options: object) => {
        const others = v7Response.getSetCookie().filter((c) => !c.startsWith(`${name}=`));
        v7Response = new Headers();
        for (const c of others) v7Response.append("set-cookie", c);
        v7Response.append("set-cookie", h3.serialize(name, value, { path: "/", ...options }));
      },
    },
  },
});
const resolve = v7("cms/resolve.ts", { expose: ["evaluateVariantRule"] });
const flags = v7("sdk/flags.ts");
const h3 = v7("vendor/h3-cookie.js");
export const v7Device = v7("sdk/useDeviceContext.tsx");
export const v7DetectDevice = v7("sdk/detectDevice.ts");

const persistFlags: (ctx: object) => StoredFlag[] = (() => {
  const text = v7Source("tanstack/routes/cmsRoute.ts");
  const start = text.indexOf("/** One year");
  const fn = text.indexOf("function persistFlags(");
  const end = text.indexOf("\n}\n", fn) + 3;
  if (!(start > 0 && fn > start && end > fn)) throw new Error("persistFlags moved in cmsRoute.ts");
  const source = [
    'import { parseSegmentCookie, SEGMENT_COOKIE, serializeSegmentCookie } from "../../sdk/flags";',
    'import { setCookie } from "./__h3";',
    text.slice(start, end),
  ].join("\n");
  return v7("tanstack/routes/__persistFlags.ts", { source, expose: ["persistFlags"] }).persistFlags;
})();

/** v7's worker: the A/B token of its cache key. */
export const v7CacheToken: (request: Request) => string = (() => {
  const text = v7Source("tanstack/sdk/workerEntry.ts");
  const fn = text.indexOf("  function readRequestCookie(");
  const end = text.indexOf("\n  }\n", fn) + 5;
  if (!(fn > 0 && end > fn)) throw new Error("readRequestCookie moved in workerEntry.ts");
  const source = [
    'import { parseSegmentCookie, SEGMENT_COOKIE, segmentCacheToken } from "../../sdk/flags";',
    text.slice(fn, end),
    "export const token = (request: Request) =>",
    "  segmentCacheToken(parseSegmentCookie(readRequestCookie(request, SEGMENT_COOKIE)));",
  ].join("\n");
  return v7("tanstack/sdk/__token.ts", { source }).token;
})();

export const seededMath = (seed: number) => vi.spyOn(Math, "random").mockImplementation(rng(seed));

// ---------------------------------------------------------------------------
// Generated pages and cookies
// ---------------------------------------------------------------------------

const COHORTS = ["Hero test", "Banner AB", "Ç test"];
export const OTHER_COOKIES = ["vtex_session=abc", "_deco_bucket=1", "theme=dark; Path=/"];

export function segmentValue(r: () => number): string {
  const roll = r();
  if (roll < 0.1) return "garbage";
  if (roll < 0.2) return btoa(encodeURIComponent(JSON.stringify({ active: ["Hero test"] })));
  return flags.serializeSegmentCookie(
    Array.from({ length: Math.floor(r() * 4) }, () => ({
      name: pick(r, [...COHORTS, "website/matchers/random.ts", "exp-1"]),
      value: pick(r, [true, false, "variant-a"]),
      pct: pick(r, [-1, 0, 30, 50, 100]),
    })),
  );
}

/** A `Cookie` header, odd ones included (quoted, encoded, undecodable, duplicated). */
export function cookieHeader(r: () => number): string | undefined {
  const parts: string[] = [];
  for (let n = Math.floor(r() * 4); n > 0; n--) {
    const roll = r();
    if (roll < 0.45) parts.push(`${SEGMENT_COOKIE}=${segmentValue(r)}`);
    else if (roll < 0.55) parts.push(`${SEGMENT_COOKIE}=${encodeURIComponent(segmentValue(r))}`);
    else if (roll < 0.6) parts.push(` ${SEGMENT_COOKIE} = "${segmentValue(r)}" `);
    else if (roll < 0.65) parts.push(`${SEGMENT_COOKIE}=%E0%A4%A`);
    else if (roll < 0.7) parts.push(SEGMENT_COOKIE);
    else parts.push(pick(r, ["a=1", "x_deco_segment=1", "b=%20c", "=v", "c"]));
  }
  return parts.length ? parts.join(pick(r, ["; ", ";", " ; "])) : undefined;
}

type Rule = { __resolveType: string; traffic?: number };

/** A page's saved random matchers and the rules it evaluates, in order. */
export interface RandomPage {
  blocks: Record<string, { __resolveType: string; traffic?: number }>;
  rules: Rule[];
}

export function randomPage(r: () => number): RandomPage {
  const traffic = pick(r, [0, 0.1, 0.3, 0.5, 0.9, 1, undefined]);
  const blocks: RandomPage["blocks"] = {};
  for (const name of COHORTS) {
    blocks[name] = {
      __resolveType: "website/matchers/random.ts",
      ...(r() < 0.9 ? { traffic: r() < 0.5 ? traffic : pick(r, [0.2, 0.5, 0.8]) } : {}),
    };
  }
  const rules = Array.from({ length: 1 + Math.floor(r() * 4) }, () =>
    r() < 0.75
      ? { __resolveType: pick(r, COHORTS) }
      : {
          __resolveType: "website/matchers/random.ts",
          ...(traffic === undefined ? {} : { traffic }),
        },
  );
  return { blocks, rules };
}

/**
 * v7 serving the page: its route's matcher context for `pageUrl`, each rule
 * in order, then `persistFlags` on a response that already sets `before`.
 */
export function v7Page(
  page: RandomPage,
  request: Request,
  pageUrl: string,
  before: string[],
  seed: number,
): { decisions: boolean[]; setCookies: string[] } {
  savedBlocks = page.blocks;
  v7Response = new Headers();
  for (const c of before) v7Response.append("set-cookie", c);
  const ctx = {
    userAgent: request.headers.get("user-agent") ?? "",
    url: pageUrl,
    path: new URL(pageUrl).pathname,
    cookies: h3.parse(request.headers.get("cookie") ?? ""),
    request,
    flags: [] as StoredFlag[],
  };
  const spy = seededMath(seed);
  try {
    const decisions = page.rules.map((rule) => resolve.evaluateVariantRule(rule, ctx) as boolean);
    persistFlags(ctx);
    return { decisions, setCookies: v7Response.getSetCookie() };
  } finally {
    spy.mockRestore();
  }
}

/**
 * v7 serving a page whose rules are one multivariate's variants: its
 * resolver's loop (cms/resolve.ts, "Multivariate flags": the first variant
 * whose `evaluateVariantRule` is true wins, later rules never run), then
 * `persistFlags`. `winner` is the index of the chosen variant, -1 for none.
 */
export function v7Multivariate(
  page: RandomPage,
  request: Request,
  pageUrl: string,
  before: string[],
  seed: number,
): { winner: number; setCookies: string[] } {
  if (!v7Source("cms/resolve.ts").includes(MULTIVARIATE_LOOP)) {
    throw new Error("v7's multivariate loop moved in cms/resolve.ts");
  }
  savedBlocks = page.blocks;
  v7Response = new Headers();
  for (const c of before) v7Response.append("set-cookie", c);
  const ctx = {
    userAgent: request.headers.get("user-agent") ?? "",
    url: pageUrl,
    path: new URL(pageUrl).pathname,
    cookies: h3.parse(request.headers.get("cookie") ?? ""),
    request,
    flags: [] as StoredFlag[],
  };
  const spy = seededMath(seed);
  try {
    const winner = page.rules.findIndex((rule) => resolve.evaluateVariantRule(rule, ctx));
    persistFlags(ctx);
    return { winner, setCookies: v7Response.getSetCookie() };
  } finally {
    spy.mockRestore();
  }
}

/** The loop `v7Multivariate` reproduces, as cms/resolve.ts has it. */
const MULTIVARIATE_LOOP = `    for (const variant of variants) {
      const rule = variant.rule as Record<string, unknown> | undefined;
      if (evaluateVariantRule(rule, rctx.matcherCtx)) {
        return internalResolve(variant.value, childCtx);
      }
    }
    return undefined;`;

/** Ours: the block map's random, the saved block's name as `cohort`. */
export function ourDecisions(page: RandomPage, input: () => MatcherInput, seed: number): boolean[] {
  const spy = seededMath(seed);
  try {
    return page.rules.map((rule) => {
      const saved = page.blocks[rule.__resolveType];
      const props = saved
        ? { traffic: saved.traffic, cohort: rule.__resolveType }
        : { traffic: rule.traffic };
      return decideRandom(props, input()).value;
    });
  } finally {
    spy.mockRestore();
  }
}
