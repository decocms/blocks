import { describe, expect, it } from "vitest";
import { decoParseSearch, decoStringifySearch } from "./router";

describe("decoStringifySearch ∘ decoParseSearch is a fixed point", () => {
  // TanStack Router redirects (307) on the server when
  // stringifySearch(parseSearch(search)) differs from the request's search —
  // every query string that round-trips unchanged is a request that never
  // redirects.
  it.each([
    "?q=camisa&sort=",
    "?utm_source=",
    "?a=&b=",
    "?q=camisa",
    "?filter.brand=Nike&filter.brand=Adidas",
    // (`%20` is re-encoded as `+` by URLSearchParams — a pre-existing
    // normalization, out of this fix's scope.)
    "?q=a+b&page=2",
  ])("round-trips %s unchanged", (search) => {
    expect(decoStringifySearch(decoParseSearch(search))).toBe(search);
  });

  it("parses a value-less param to an empty string", () => {
    expect(decoParseSearch("?q=camisa&sort=")).toEqual({ q: "camisa", sort: "" });
  });

  it("still drops undefined and null (how navigate() removes a param)", () => {
    expect(decoStringifySearch({ q: "camisa", sort: undefined, page: null })).toBe("?q=camisa");
    expect(decoStringifySearch({ q: undefined })).toBe("");
  });

  it("keeps an explicit empty string as key= and arrays as repeated keys", () => {
    expect(decoStringifySearch({ sort: "", f: ["a", "b"] })).toBe("?sort=&f=a&f=b");
  });
});
