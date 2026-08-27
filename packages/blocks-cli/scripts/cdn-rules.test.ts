import { BOT_UA_SUBSTRINGS, isBot } from "@decocms/blocks/cms";
import { DECO_MATCHERS_OVERRIDE_PARAM } from "@decocms/blocks/matchers/override";
import { SEGMENT_COOKIE } from "@decocms/blocks/sdk/flags";
import { describe, expect, it } from "vitest";
import { AUTH_COOKIE_PREFIXES, bypassExpression, cacheRuleset } from "./cdn-rules";

/**
 * These are drift tests, not behaviour tests. The CDN rules and the Worker's
 * cache key are two descriptions of the same segmentation; when they disagree,
 * one visitor gets another's response. Each assertion below pins one dimension
 * to the constant the Worker actually uses.
 */
describe("CDN bypass expression tracks the worker cache key", () => {
  const expr = bypassExpression();

  it("bypasses authenticated visitors", () => {
    // Without this, a logged-in request is answered from the anonymous CDN
    // entry and the Worker never runs — no header can save it.
    for (const name of AUTH_COOKIE_PREFIXES) {
      expect(expr).toContain(`http.cookie contains "${name}"`);
    }
  });

  it("bypasses the A/B cohort cookie by its real name (__abf)", () => {
    expect(expr).toContain(`${SEGMENT_COOKIE}=`);
  });

  it("bypasses every bot UA the framework renders eagerly (__bot)", () => {
    for (const ua of BOT_UA_SUBSTRINGS) {
      expect(expr).toContain(ua);
      // The list is only meaningful if it really is what isBot() matches.
      expect(isBot(`Mozilla/5.0 (compatible; ${ua}/1.0)`)).toBe(true);
    }
  });

  it("bypasses programmatic fetches (__fetch)", () => {
    expect(expr).toContain("sec-fetch-dest");
  });

  it("bypasses matcher overrides by their real param name", () => {
    expect(expr).toContain(DECO_MATCHERS_OVERRIDE_PARAM);
  });

  it("bypasses draft preview", () => {
    expect(expr).toContain("__draft=");
    expect(expr).toContain("__deco_draft");
  });

  it("is scoped to hostnames that opted in", () => {
    // A shared zone: an unscoped rule would enable every site at once.
    expect(expr).toContain("cf.hostname.metadata");
    for (const rule of cacheRuleset().rules) {
      expect(rule.expression).toContain("cf.hostname.metadata");
    }
  });
});

describe("cache ruleset", () => {
  const [bypass, cache] = cacheRuleset().rules;

  it("evaluates bypass before caching", () => {
    expect(bypass.action_parameters.cache).toBe(false);
    expect(cache.action_parameters.cache).toBe(true);
  });

  it("keys by device, since deviceSpecificKeys defaults to true", () => {
    expect(cache.action_parameters.cache_key?.cache_by_device_type).toBe(true);
  });

  it("takes the TTL from the origin, not a copy of the profile table", () => {
    expect(cache.action_parameters.edge_ttl?.mode).toBe("respect_origin");
  });
});
