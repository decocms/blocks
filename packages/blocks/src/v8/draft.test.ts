// @vitest-environment node
/** Draft pointers (api-reference#draft-pointers, hosted-drafts.mdx). */
import { describe, expect, it } from "vitest";
import { createCMS } from "./cms";
import { formatDraftPointer, parseDraftPointer } from "./draft";
import type { RequestLike } from "./types";

/** The helpers as a site calls them: methods of a CMS with no settings, so every host may preview. */
const cms = createCMS({ blocks: {}, content: { revision: "r", blocks: {} } });
const draftPointer = (request: RequestLike) => cms.draftPointer(request);
const draftCookie = (request: RequestLike) => cms.draftCookie(request);
const DRAFT_COOKIE = "deco-draft";

const POINTER = "api.deco.example/drafts/acme/main?token=abc.def-ghi@9f3c1a";

describe("parseDraftPointer", () => {
  it("parses <host[:port]><path[?query]>@<version>", () => {
    expect(parseDraftPointer(POINTER)).toEqual({
      host: "api.deco.example",
      path: "/drafts/acme/main?token=abc.def-ghi",
      version: "9f3c1a",
    });
  });

  it("accepts a port and a single-label host", () => {
    expect(parseDraftPointer("localhost:4000/drafts/x@v1")).toEqual({
      host: "localhost:4000",
      path: "/drafts/x",
      version: "v1",
    });
  });

  it("accepts a bracketed IPv6 host, with or without a port, in a URL's form", () => {
    expect(parseDraftPointer("[::1]:4000/changes?token=t@v1")).toEqual({
      host: "[::1]:4000",
      path: "/changes?token=t",
      version: "v1",
    });
    expect(parseDraftPointer("[0:0:0:0:0:0:0:1]/x@v1")?.host).toBe("[::1]");
  });

  it("lowercases the host and keeps path and version as they are", () => {
    expect(parseDraftPointer("API.Deco.Example/Drafts/X?T=Y@AbC_1.2-3")).toEqual({
      host: "api.deco.example",
      path: "/Drafts/X?T=Y",
      version: "AbC_1.2-3",
    });
  });

  it("keeps percent-encoded characters in the path as they are", () => {
    expect(parseDraftPointer("api.deco.example/drafts/a%2Fb?token=x%3Dy@v")?.path).toBe(
      "/drafts/a%2Fb?token=x%3Dy",
    );
  });

  const invalid: [string, string | null | undefined][] = [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["a scheme", "https://api.deco.example/drafts/x@v1"],
    ["a protocol-relative URL", "//api.deco.example/drafts/x@v1"],
    ["a stray @ in the path", "api.deco.example/drafts/a@b@v1"],
    ["userinfo", "user@api.deco.example/drafts/x@v1"],
    ["no version", "api.deco.example/drafts/x@"],
    ["no @ at all", "api.deco.example/drafts/x"],
    ["an unrooted path (no path)", "api.deco.example@v1"],
    ["an empty host", "/drafts/x@v1"],
    ["an odd character in the host", "api_deco.example/drafts/x@v1"],
    ["a host ending with a dash", "api-.example/x@v1"],
    ["an odd character in the version", "api.deco.example/drafts/x@v1/2"],
    ["a version too long", `api.deco.example/x@${"a".repeat(65)}`],
    ["a non-numeric port", "localhost:abc/x@v1"],
    ["a port out of range", "localhost:70000/x@v1"],
    ["two ports", "localhost:1:2/x@v1"],
    ["whitespace", "api.deco.example/drafts/x y@v1"],
    ["a fragment", "api.deco.example/drafts/x#frag@v1"],
    ["a double slash path", "api.deco.example//evil.example/x@v1"],
    ["an unclosed IPv6 bracket", "[::1/x@v1"],
    ["a name in brackets", "[evil.example]/x@v1"],
    ["junk after an IPv6 bracket", "[::1]evil.example/x@v1"],
    ["an IPv6 port out of range", "[::1]:70000/x@v1"],
    ["something absurdly long", `api.deco.example/${"a".repeat(5000)}@v1`],
  ];
  for (const [label, raw] of invalid) {
    it(`returns null on ${label}`, () => {
      expect(parseDraftPointer(raw)).toBeNull();
    });
  }
});

describe("formatDraftPointer", () => {
  it("is the inverse of parseDraftPointer (the api-reference example)", () => {
    expect(
      formatDraftPointer({
        host: "api.deco.example",
        path: "/drafts/acme/main?token=t",
        version: "9f3c1a",
      }),
    ).toBe("api.deco.example/drafts/acme/main?token=t@9f3c1a");
    const parsed = parseDraftPointer(POINTER);
    expect(parsed).not.toBeNull();
    expect(formatDraftPointer(parsed!)).toBe(POINTER);
  });

  it("throws a TypeError on parts that can't form a pointer that parses", () => {
    expect(() => formatDraftPointer({ host: "a b", path: "/x", version: "v" })).toThrow(TypeError);
    expect(() => formatDraftPointer({ host: "h", path: "x", version: "v" })).toThrow(TypeError);
    expect(() => formatDraftPointer({ host: "h", path: "/x", version: "v@w" })).toThrow(TypeError);
    expect(() => formatDraftPointer({ host: "h", path: "/x@y", version: "v" })).toThrow(TypeError);
  });
});

describe("forced variants (the __variant parameters)", () => {
  const forced = encodeURIComponent("Home Page@sections.3=1");

  it("lifts them out of the path into variants, keeping the other parameters", () => {
    expect(parseDraftPointer(`localhost:4547/live?a=1&__variant=${forced}&b=2@local`)).toEqual({
      host: "localhost:4547",
      path: "/live?a=1&b=2",
      version: "local",
      variants: [{ block: "Home Page", path: "sections.3", index: 1 }],
    });
  });

  it("drops the query when only __variant parameters remain; an empty path addresses the block", () => {
    const own = encodeURIComponent("Flag@=2");
    expect(parseDraftPointer(`localhost:4547/?__variant=${own}&__variant=${forced}@v`)).toEqual({
      host: "localhost:4547",
      path: "/",
      version: "v",
      variants: [
        { block: "Flag", path: "", index: 2 },
        { block: "Home Page", path: "sections.3", index: 1 },
      ],
    });
  });

  it("splits on the last @ before the last =", () => {
    const value = encodeURIComponent("a@b@sections.0=0");
    expect(parseDraftPointer(`h/?__variant=${value}@v`)?.variants).toEqual([
      { block: "a@b", path: "sections.0", index: 0 },
    ]);
  });

  const bad: [string, string][] = [
    ["no block", encodeURIComponent("@sections.1=0")],
    ["no @", encodeURIComponent("Home=0")],
    ["no index", encodeURIComponent("Home@sections")],
    ["a negative index", encodeURIComponent("Home@sections=-1")],
    ["a non-integer index", encodeURIComponent("Home@sections=1.5")],
    ["an index past 9999", encodeURIComponent("Home@sections=10000")],
    ["an empty path segment", encodeURIComponent("Home@sections..1=0")],
    ["bad percent-encoding", "Home%E0%A4%A@x=0"],
  ];
  for (const [label, value] of bad) {
    it(`a pointer with ${label} doesn't parse`, () => {
      expect(parseDraftPointer(`h/x?__variant=${value}@v`)).toBeNull();
    });
  }

  it("format appends them, encoded, and round-trips", () => {
    const pointer = {
      host: "api.deco.example",
      path: "/drafts/acme/main?token=t",
      version: "9f3c1a",
      variants: [
        { block: "Home (copy)", path: "sections.variants.0.value.2", index: 1 },
        { block: "Header", path: "", index: 0 },
      ],
    };
    const raw = formatDraftPointer(pointer);
    expect(raw).toBe(
      "api.deco.example/drafts/acme/main?token=t" +
        "&__variant=Home%20%28copy%29%40sections.variants.0.value.2%3D1" +
        "&__variant=Header%40%3D0@9f3c1a",
    );
    expect(parseDraftPointer(raw)).toEqual(pointer);
    expect(formatDraftPointer({ host: "h", path: "/", version: "v", variants: [] })).toBe("h/@v");
  });

  it("format throws on a variant that wouldn't parse back, or a path that already carries one", () => {
    const base = { host: "h", path: "/x", version: "v" };
    expect(() =>
      formatDraftPointer({ ...base, variants: [{ block: "", path: "", index: 0 }] }),
    ).toThrow(TypeError);
    expect(() =>
      formatDraftPointer({ ...base, variants: [{ block: "B", path: "a..b", index: 0 }] }),
    ).toThrow(TypeError);
    expect(() =>
      formatDraftPointer({ ...base, variants: [{ block: "B", path: "", index: 1.5 }] }),
    ).toThrow(TypeError);
    expect(() => formatDraftPointer({ ...base, path: `/x?__variant=${forced}` })).toThrow(
      TypeError,
    );
  });

  it("draftCookie stores a pointer with forced variants", async () => {
    const pointer = `localhost:4547/?__variant=${forced}@local`;
    expect(
      await draftCookie(request(`https://s.example/?__draft=${encodeURIComponent(pointer)}`)),
    ).toContain(`${DRAFT_COOKIE}=${encodeURIComponent(pointer)};`);
  });
});

function request(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

describe("draftPointer", () => {
  const encoded = encodeURIComponent(POINTER);

  it("reads ?__draft= from the URL first", async () => {
    expect(await draftPointer(request(`https://store.example.com/summer?__draft=${encoded}`))).toBe(
      POINTER,
    );
  });

  it("prefers the URL over the cookie", async () => {
    const other = encodeURIComponent("api.deco.example/drafts/other@v2");
    expect(
      await draftPointer(
        request(`https://store.example.com/?__draft=${encoded}`, `${DRAFT_COOKIE}=${other}`),
      ),
    ).toBe(POINTER);
  });

  it("then reads the deco-draft cookie", async () => {
    expect(
      await draftPointer(
        request("https://store.example.com/summer", `theme=dark; ${DRAFT_COOKIE}=${encoded}; x=1`),
      ),
    ).toBe(POINTER);
  });

  it("returns null when neither is present", async () => {
    expect(await draftPointer(request("https://store.example.com/summer"))).toBeNull();
    expect(await draftPointer(request("https://store.example.com/summer", "other=1"))).toBeNull();
  });

  it("returns null when the URL says ?__draft=off, even with a cookie", async () => {
    expect(
      await draftPointer(
        request("https://store.example.com/?__draft=off", `${DRAFT_COOKIE}=${encoded}`),
      ),
    ).toBeNull();
  });

  it("an empty ?__draft= falls back to the cookie", async () => {
    expect(
      await draftPointer(
        request("https://store.example.com/?__draft=", `${DRAFT_COOKIE}=${encoded}`),
      ),
    ).toBe(POINTER);
  });

  it("returns the value as is: forDraft validates it", async () => {
    expect(await draftPointer(request("https://store.example.com/?__draft=garbage"))).toBe(
      "garbage",
    );
  });

  it("takes anything with url and headers (a framework wrapper)", async () => {
    expect(
      await draftPointer({
        url: `https://store.example.com/?__draft=${encoded}`,
        headers: new Headers(),
      }),
    ).toBe(POINTER);
    expect(await draftPointer({ url: "/relative?__draft=x", headers: new Headers() })).toBe("x");
  });

  it("ignores a cookie whose name only ends with deco-draft", async () => {
    expect(
      await draftPointer(request("https://s.example/", `not-deco-draft=${encoded}`)),
    ).toBeNull();
  });

  it("returns null on an undecodable cookie", async () => {
    expect(
      await draftPointer(request("https://s.example/", `${DRAFT_COOKIE}=%E0%A4%A`)),
    ).toBeNull();
  });
});

describe("draftCookie", () => {
  it("stores the pointer when the URL carries ?__draft= (Secure; SameSite=None; Partitioned — D4)", async () => {
    const cookie = await draftCookie(
      request(`https://store.example.com/summer?__draft=${encodeURIComponent(POINTER)}`),
    );
    expect(cookie).toBe(
      `${DRAFT_COOKIE}=${encodeURIComponent(POINTER)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("round-trips: the stored cookie is read back by draftPointer", async () => {
    const cookie = await draftCookie(
      request(`https://s.example/?__draft=${encodeURIComponent(POINTER)}`),
    );
    const pair = cookie!.split(";")[0]!;
    expect(await draftPointer(request("https://s.example/next-page", pair))).toBe(POINTER);
  });

  it("expires the cookie on ?__draft=off (how the site editor ends a preview)", async () => {
    expect(await draftCookie(request("https://store.example.com/?__draft=off"))).toBe(
      `${DRAFT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("is null on every other request", async () => {
    expect(await draftCookie(request("https://store.example.com/summer"))).toBeNull();
    expect(
      await draftCookie(
        request(
          "https://store.example.com/summer",
          `${DRAFT_COOKIE}=${encodeURIComponent(POINTER)}`,
        ),
      ),
    ).toBeNull();
    expect(await draftCookie(request("https://store.example.com/?__draft="))).toBeNull();
  });

  it("never stores a pointer that doesn't parse", async () => {
    expect(
      await draftCookie(request("https://store.example.com/?__draft=https://evil.example/x@1")),
    ).toBeNull();
    expect(await draftCookie(request("https://store.example.com/?__draft=garbage"))).toBeNull();
  });
});
