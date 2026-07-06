import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBlocks } from "../cms/loader";
import type { MatcherContext } from "../cms/resolve";
import { evaluateMatcher, registerMatcher } from "../cms/resolve";
import { DECO_MATCHERS_OVERRIDE_PARAM, getMatchersOverride } from "./override";

const TEST_MATCHER_KEY = "test/matchers/flag.ts";
// Block names with spaces are only addressable via query string — the header
// format splits pairs on spaces (same limitation as the Deno runtime).
const SAVED_BLOCK = "Segmento Mobile";
const SAVED_BLOCK_NO_SPACE = "PromoAtiva";

const matcherFn = vi.fn(
  (rule: Record<string, unknown>) => (rule.result as boolean | undefined) ?? false,
);

function ctxWithHeader(value: string): MatcherContext {
  return {
    url: "https://example.com/",
    request: new Request("https://example.com/", {
      headers: { [DECO_MATCHERS_OVERRIDE_PARAM]: value },
    }),
  };
}

function ctxWithQS(search: string): MatcherContext {
  const url = `https://example.com/?${search}`;
  return { url, request: new Request(url) };
}

beforeEach(() => {
  matcherFn.mockClear();
  registerMatcher(TEST_MATCHER_KEY, matcherFn);
  setBlocks({
    [SAVED_BLOCK]: { __resolveType: TEST_MATCHER_KEY, result: true },
    [SAVED_BLOCK_NO_SPACE]: { __resolveType: TEST_MATCHER_KEY, result: true },
  });
});

describe("getMatchersOverride", () => {
  it("parses space-separated pairs from the header", () => {
    const overrides = getMatchersOverride(ctxWithHeader("a=1 b=0"));
    expect(overrides).toEqual({ a: true, b: false });
  });

  it("parses repeated query string params, including names with spaces", () => {
    const overrides = getMatchersOverride(
      ctxWithQS(
        `${DECO_MATCHERS_OVERRIDE_PARAM}=Segmento%20Mobile%3D1&${DECO_MATCHERS_OVERRIDE_PARAM}=b%3D0`,
      ),
    );
    expect(overrides).toEqual({ "Segmento Mobile": true, b: false });
  });

  it("prefers the header over the query string", () => {
    const url = `https://example.com/?${DECO_MATCHERS_OVERRIDE_PARAM}=a%3D0`;
    const ctx: MatcherContext = {
      url,
      request: new Request(url, {
        headers: { [DECO_MATCHERS_OVERRIDE_PARAM]: "a=1" },
      }),
    };
    expect(getMatchersOverride(ctx)).toEqual({ a: true });
  });

  it("falls back to the headers record when no Request is present", () => {
    const overrides = getMatchersOverride({
      headers: { [DECO_MATCHERS_OVERRIDE_PARAM]: "a=1" },
    });
    expect(overrides).toEqual({ a: true });
  });

  it("returns an empty object when no override is present", () => {
    expect(getMatchersOverride({ url: "https://example.com/" })).toEqual({});
    expect(getMatchersOverride({})).toEqual({});
  });
});

describe("evaluateMatcher with overrides", () => {
  it("forces a saved matcher block to false via header without running it", () => {
    const result = evaluateMatcher(
      { __resolveType: SAVED_BLOCK_NO_SPACE },
      ctxWithHeader(`${SAVED_BLOCK_NO_SPACE}=0`),
    );
    expect(result).toBe(false);
    expect(matcherFn).not.toHaveBeenCalled();
  });

  it("forces a spaced-name block to false via query string", () => {
    const result = evaluateMatcher(
      { __resolveType: SAVED_BLOCK },
      ctxWithQS(`${DECO_MATCHERS_OVERRIDE_PARAM}=${encodeURIComponent(`${SAVED_BLOCK}=0`)}`),
    );
    expect(result).toBe(false);
    expect(matcherFn).not.toHaveBeenCalled();
  });

  it("forces a saved matcher block to true without running it", () => {
    setBlocks({
      [SAVED_BLOCK]: { __resolveType: TEST_MATCHER_KEY, result: false },
    });
    const result = evaluateMatcher(
      { __resolveType: SAVED_BLOCK },
      ctxWithQS(`${DECO_MATCHERS_OVERRIDE_PARAM}=${encodeURIComponent(`${SAVED_BLOCK}=1`)}`),
    );
    expect(result).toBe(true);
    expect(matcherFn).not.toHaveBeenCalled();
  });

  it("runs the matcher normally when no override targets it", () => {
    const result = evaluateMatcher(
      { __resolveType: SAVED_BLOCK },
      ctxWithHeader("Outro Segmento=0"),
    );
    expect(result).toBe(true);
    expect(matcherFn).toHaveBeenCalledTimes(1);
  });

  it("does not affect inline matchers keyed by raw type", () => {
    const result = evaluateMatcher(
      { __resolveType: TEST_MATCHER_KEY, result: true },
      ctxWithHeader(`${TEST_MATCHER_KEY}=0`),
    );
    expect(result).toBe(true);
    expect(matcherFn).toHaveBeenCalledTimes(1);
  });
});
