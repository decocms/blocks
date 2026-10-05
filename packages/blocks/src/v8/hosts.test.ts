// @vitest-environment node
/** Host patterns (api-reference#host-patterns): parsing, matching and "within". */
import { describe, expect, it } from "vitest";
import {
  allowsHost,
  formatHostPattern,
  type HostPattern,
  parseHostPattern,
  patternWithin,
} from "./hosts";

const parse = (raw: string): HostPattern => {
  const pattern = parseHostPattern(raw);
  if (pattern === null) throw new Error(`not a pattern: ${raw}`);
  return pattern;
};
const allows = (patterns: string[], url: string) => allowsHost(patterns.map(parse), url);
const within = (inner: string, outer: string) => patternWithin(parse(inner), parse(outer));

describe("parseHostPattern", () => {
  it.each([
    ["*", "*"],
    ["staging.example.com", "staging.example.com"],
    ["Staging.Example.COM.", "staging.example.com"],
    ["*.example.com", "*.example.com"],
    ["*.Example.com.", "*.example.com"],
    ["localhost", "localhost"],
    ["localhost:3000", "localhost:3000"],
    ["localhost:03000", "localhost:3000"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.0.0.1:8080", "127.0.0.1:8080"],
    ["[::1]", "[::1]"],
    ["[0:0:0:0:0:0:0:1]:5173", "[::1]:5173"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["*.bücher.example", "*.xn--bcher-kva.example"],
  ])("%s is a pattern (normal form %s)", (raw, normal) => {
    expect(formatHostPattern(parse(raw))).toBe(normal);
  });

  it.each([
    "",
    " ",
    "staging.example.com ",
    " staging.example.com",
    "https://staging.example.com",
    "staging.example.com/path",
    "staging.example.com/",
    "a..example.com",
    ".example.com",
    "example.com..",
    "a*.example.com",
    "*a.example.com",
    "*.*.com",
    "x.*.example.com",
    "*.com",
    "*.",
    "**",
    "*.example.com*",
    "*:3000",
    "*.1.2.3.4",
    "*.[::1]",
    "1.2.3",
    "01.2.3.4",
    "256.1.1.1",
    "0x7f.0.0.1",
    "::1",
    "[::1",
    "[zz::1]",
    "example.com:",
    "example.com:abc",
    "example.com:70000",
    "example.com:80:80",
    "user@example.com",
    "example.com?x",
    "example.com#x",
    "exa mple.com",
    "exa\tmple.com",
    "-",
  ])("%j is not a pattern", (raw) => {
    expect(parseHostPattern(raw)).toBeNull();
  });

  it("rejects anything that isn't a string", () => {
    for (const raw of [null, undefined, 1, {}, ["a.com"], true]) {
      expect(parseHostPattern(raw)).toBeNull();
    }
  });
});

describe("matching a request's host", () => {
  it('"*" matches every host, and even a URL that can\'t be read', () => {
    expect(allows(["*"], "https://anything.example/")).toBe(true);
    expect(allows(["*"], "/relative")).toBe(true);
    expect(allows(["*"], "not a url")).toBe(true);
  });

  it("an exact name matches only itself, on any port", () => {
    const list = ["staging.example.com"];
    expect(allows(list, "https://staging.example.com/x")).toBe(true);
    expect(allows(list, "http://staging.example.com:8080/")).toBe(true);
    expect(allows(list, "https://STAGING.Example.com/")).toBe(true);
    expect(allows(list, "https://staging.example.com./")).toBe(true);
    expect(allows(list, "https://example.com/")).toBe(false);
    expect(allows(list, "https://www.staging.example.com/")).toBe(false);
    expect(allows(list, "https://staging.example.com.attacker.com/")).toBe(false);
    expect(allows(list, "https://xstaging.example.com/")).toBe(false);
  });

  it("*.name matches one or more labels in front, label by label from the right", () => {
    const list = ["*.example.com"];
    expect(allows(list, "https://a.example.com/")).toBe(true);
    expect(allows(list, "https://a.b.example.com/")).toBe(true);
    expect(allows(list, "https://A.EXAMPLE.COM./")).toBe(true);
    expect(allows(list, "https://example.com/")).toBe(false);
    expect(allows(list, "https://badexample.com/")).toBe(false);
    expect(allows(list, "https://a.badexample.com/")).toBe(false);
    expect(allows(list, "https://a.example.com.attacker.com/")).toBe(false);
    expect(allows(list, "https://example.com.attacker.com/")).toBe(false);
    expect(allows(list, "https://a.example.co/")).toBe(false);
    expect(allows(list, "https://a.example.com../")).toBe(false);
  });

  it("a pattern with a port matches only a URL naming that port; default ports are never named", () => {
    expect(allows(["localhost:3000"], "http://localhost:3000/")).toBe(true);
    expect(allows(["localhost:3000"], "http://localhost/")).toBe(false);
    expect(allows(["localhost:3000"], "http://localhost:3001/")).toBe(false);
    expect(allows(["*.example.com:8443"], "https://a.example.com:8443/")).toBe(true);
    expect(allows(["*.example.com:8443"], "https://a.example.com/")).toBe(false);
    expect(allows(["example.com:443"], "https://example.com:443/")).toBe(false);
  });

  it("punycode: a non-ASCII host matches its pattern in either spelling", () => {
    expect(allows(["bücher.example"], "https://xn--bcher-kva.example/")).toBe(true);
    expect(allows(["xn--bcher-kva.example"], "https://bücher.example/")).toBe(true);
    expect(allows(["*.bücher.example"], "https://shop.bücher.example/")).toBe(true);
  });

  it("IP addresses match exactly, in the form a URL gives them", () => {
    expect(allows(["127.0.0.1"], "http://127.0.0.1:5173/")).toBe(true);
    expect(allows(["127.0.0.1"], "http://0x7f.0.0.1/")).toBe(true); // the URL normalizes it
    expect(allows(["127.0.0.1"], "http://127.0.0.2/")).toBe(false);
    expect(allows(["[::1]"], "http://[0:0::1]:3000/")).toBe(true);
    expect(allows(["*.example.com"], "http://127.0.0.1/")).toBe(false);
  });

  it("a URL that can't be read matches no pattern but *", () => {
    expect(allows(["localhost"], "/relative?__draft=x")).toBe(false);
    expect(allows(["*.example.com"], "")).toBe(false);
  });

  it("userinfo can't smuggle a host in", () => {
    expect(allows(["staging.example.com"], "https://staging.example.com@evil.com/")).toBe(false);
    expect(allows(["*.example.com"], "https://a.example.com:x@evil.com/")).toBe(false);
  });

  it("an empty list matches nothing", () => {
    expect(allowsHost([], "https://example.com/")).toBe(false);
  });
});

describe("a content entry within code's entry", () => {
  it("names and wildcards", () => {
    expect(within("staging.example.com", "*.example.com")).toBe(true);
    expect(within("a.b.example.com", "*.example.com")).toBe(true);
    expect(within("*.a.example.com", "*.example.com")).toBe(true);
    expect(within("*.example.com", "*.example.com")).toBe(true);
    expect(within("*.example.com", "*.a.example.com")).toBe(false);
    expect(within("example.com", "*.example.com")).toBe(false);
    expect(within("*.example.com", "example.com")).toBe(false);
    expect(within("staging.example.com", "staging.example.com")).toBe(true);
    expect(within("other.example.com", "staging.example.com")).toBe(false);
    expect(within("store.attacker.com", "*.example.com")).toBe(false);
    expect(within("a.example.com.attacker.com", "*.example.com")).toBe(false);
    expect(within("*.badexample.com", "*.example.com")).toBe(false);
  });

  it('"*" is within only "*"; everything is within "*"', () => {
    expect(within("*", "*")).toBe(true);
    expect(within("*", "*.example.com")).toBe(false);
    expect(within("*.example.com", "*")).toBe(true);
    expect(within("localhost:3000", "*")).toBe(true);
  });

  it("ports: no port is within only no port; port P is within no port or P", () => {
    expect(within("localhost", "localhost:3000")).toBe(false);
    expect(within("localhost:3000", "localhost")).toBe(true);
    expect(within("localhost:3000", "localhost:3000")).toBe(true);
    expect(within("localhost:3001", "localhost:3000")).toBe(false);
    expect(within("a.example.com:8080", "*.example.com")).toBe(true);
    expect(within("*.example.com", "*.example.com:8080")).toBe(false);
  });

  it("IP addresses: only the same address", () => {
    expect(within("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(within("127.0.0.1:3000", "127.0.0.1")).toBe(true);
    expect(within("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(within("[::1]", "[::1]")).toBe(true);
  });
});
