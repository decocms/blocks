// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decoParseSearch, decoStringifySearch } from "./index.ts";

describe("search params (v7's createDecoRouter, with #646)", () => {
  it.each([
    "?q=",
    "?sort=",
    "?q=&page=2",
    "?utm_source=",
    "?filter.size=M&filter.size=L",
    "?filter.brand=Nike&filter.brand=Adidas&q=shoe",
    "?q=caf%C3%A9",
    "",
  ])("%s round-trips unchanged (no 307 to a normalized URL)", (search) => {
    expect(decoStringifySearch(decoParseSearch(search))).toBe(search);
  });

  it("repeated keys become arrays; a single value stays a string", () => {
    expect(decoParseSearch("?a=1&a=2&b=3&c=")).toEqual({ a: ["1", "2"], b: "3", c: "" });
  });

  it("undefined and null remove a param; an empty string keeps it", () => {
    expect(decoStringifySearch({ q: undefined, page: null, sort: "", n: 2 })).toBe("?sort=&n=2");
  });
});
