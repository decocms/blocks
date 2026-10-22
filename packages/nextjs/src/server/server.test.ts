// @vitest-environment node
/**
 * The pages' half. `next/headers` is the request's headers, and React's
 * `cache()` (one slot per request in Server Components) is a slot per test.
 */
import { newVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../__tests__/fixtures.ts";

const request = vi.hoisted(() => ({ headers: new Headers(), reads: 0 }));

vi.mock("next/headers.js", () => ({
  headers: async () => {
    request.reads += 1;
    return request.headers;
  },
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slots = new Map<unknown, unknown>();
  (globalThis as { __resetCache?: () => void }).__resetCache = () => slots.clear();
  return {
    ...react,
    cache:
      <T>(fn: () => T) =>
      () => {
        if (!slots.has(fn)) slots.set(fn, fn());
        return slots.get(fn) as T;
      },
  };
});

const { activeDraftPointer, bindDraft, contentClient, assignedClient, assignmentsSegment } =
  await import("./index.ts");

function serve(headers: Record<string, string>): void {
  request.headers = new Headers({ host: "shop.example.com", ...headers });
  request.reads = 0;
  (globalThis as { __resetCache?: () => void }).__resetCache?.();
}

const cookie = { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` };

beforeEach(() => serve({}));

describe("bindDraft", () => {
  it("the page's ?__draft= first, then the proxy's x-deco-version, then the cookie", async () => {
    const other = "studio.decocms.com/api/acme/decofile/mcp/other@v2";
    serve({ "x-deco-version": other, ...cookie });
    expect(await bindDraft(testCMS(), { searchParams: { __draft: [POINTER, "x"] } })).toBe(true);
    expect(activeDraftPointer()).toBe(POINTER);

    serve({ "x-deco-version": other, ...cookie });
    expect(await bindDraft(testCMS())).toBe(true);
    expect(activeDraftPointer()).toBe(other);

    serve(cookie);
    expect(await bindDraft(testCMS())).toBe(true);
    expect(activeDraftPointer()).toBe(POINTER);
  });

  it("?__draft=off and no draft leave the release", async () => {
    serve(cookie);
    expect(await bindDraft(testCMS(), { searchParams: { __draft: "off" } })).toBe(false);
    expect(activeDraftPointer()).toBe(null);
    serve({});
    expect(await bindDraft(testCMS())).toBe(false);
    serve({ "x-deco-version": "junk" });
    expect(await bindDraft(testCMS())).toBe(false);
  });

  it("the same host allowlist as the proxy, on the visitor's host", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.shop.example.com"] }));
    serve({ "x-deco-version": POINTER });
    expect(await bindDraft(cms, { site: "acme" })).toBe(false); // a forged header on a host that may not preview
    serve({ "x-deco-version": POINTER, "x-forwarded-host": "acme.deco.site" });
    expect(await bindDraft(cms, { site: "acme" })).toBe(true);
    serve({ "x-deco-version": POINTER, "x-forwarded-host": "acme.deco.site" });
    expect(await bindDraft(cms, { site: "acme", previewHosts: "none" })).toBe(false);
  });

  it("with previews off everywhere it never reads the request, so a cached (ISR) page stays cached", async () => {
    serve(cookie);
    expect(await bindDraft(testCMS(snapshot({ previewHosts: [] })))).toBe(false);
    expect(await bindDraft(testCMS(), { previewHosts: "none" })).toBe(false);
    expect(request.reads).toBe(0);
  });
});

describe("contentClient", () => {
  it("cms.client({ visitor, version }) with what bindDraft bound", async () => {
    const cms = { client: vi.fn(() => "client") };
    expect(contentClient(cms as never)).toBe("client");
    expect(cms.client).toHaveBeenLastCalledWith({ visitor: null, version: null });
    const visitor = newVisitor();
    serve({ ...cookie, "x-deco-visitor": serializeVisitor(visitor) });
    await bindDraft(testCMS());
    contentClient(cms as never);
    expect(cms.client).toHaveBeenLastCalledWith({ visitor, version: POINTER });
  });
});

describe("the visitor the proxy forwarded", () => {
  const withTests = () =>
    testCMS(snapshot({ previewHosts: ["shop.example.com"], experiments: { "buy-button": 100 } }));
  const buyButton = async () => (await contentClient(withTests()).resolve("BuyButton"))[0];

  it("decides the tests through bindDraft and contentClient", async () => {
    serve({ "x-deco-visitor": serializeVisitor(newVisitor()) });
    expect(await bindDraft(withTests())).toBe(false);
    expect(await buyButton()).toBe("new");
    // Without a visitor every test is off.
    serve({});
    await bindDraft(withTests());
    expect(await buyButton()).toBe("old");
    serve({ "x-deco-visitor": "junk" });
    await bindDraft(withTests());
    expect(await buyButton()).toBe("old");
  });

  it("a preview's client gets it too", async () => {
    const cms = { client: vi.fn(() => "client") };
    const visitor = newVisitor();
    serve({ ...cookie, "x-deco-visitor": serializeVisitor(visitor) });
    expect(await bindDraft(testCMS())).toBe(true);
    contentClient(cms as never);
    expect(cms.client).toHaveBeenLastCalledWith({ visitor, version: POINTER });
  });

  it("a preview link's moment and switched tests and campaigns reach the client; the proxy's decisions win", async () => {
    const cms = { client: vi.fn(() => "client") };
    const at = encodeURIComponent("2026-11-28T10:00:00Z");
    const link = POINTER.replace(
      "@",
      `&__at=${at}&__test=${encodeURIComponent("a=on")}&__campaign=${encodeURIComponent("c=off")}@`,
    );
    serve({});
    expect(await bindDraft(testCMS(), { searchParams: { __draft: link } })).toBe(true);
    expect(activeDraftPointer()).toBe(POINTER);
    contentClient(cms as never);
    expect(cms.client).toHaveBeenLastCalledWith({
      visitor: null,
      version: POINTER,
      date: new Date("2026-11-28T10:00:00Z"),
      experiments: { a: true },
      campaigns: { c: false },
    });
    serve({
      "x-deco-assignments": assignmentsSegment({
        experiments: { a: true, b: false },
        campaigns: { c: true },
      }),
    });
    await bindDraft(testCMS(), { searchParams: { __draft: link } });
    contentClient(cms as never);
    expect(cms.client).toHaveBeenLastCalledWith({
      visitor: null,
      version: POINTER,
      date: new Date("2026-11-28T10:00:00Z"),
      experiments: { a: true, b: false },
      campaigns: { c: true },
    });
  });

  it("an old release by its SHA binds like a draft", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    serve({ "x-deco-version": sha });
    expect(await bindDraft(testCMS(snapshot({ previewHosts: ["shop.example.com"] })))).toBe(true);
    expect(activeDraftPointer()).toBe(sha);
  });

  it("a release with no experiments never reads the header, so a cached (ISR) page stays cached", async () => {
    serve({ "x-deco-visitor": serializeVisitor(newVisitor()) });
    expect(await bindDraft(testCMS(snapshot({ previewHosts: [] })))).toBe(false);
    expect(request.reads).toBe(0);
    const cms = { client: vi.fn(() => "client") };
    contentClient(cms as never);
    expect(cms.client).toHaveBeenLastCalledWith({ visitor: null, version: null });
  });
});

describe("the assignments the proxy forwarded", () => {
  const content = () =>
    testCMS(
      snapshot({ previewHosts: ["shop.example.com"], experiments: { "buy-button": 50, dark: 0 } }),
    );
  const forward = (experiments: Record<string, boolean>) => ({
    "x-deco-assignments": assignmentsSegment({ experiments, campaigns: {} }),
  });

  it("the page renders what the proxy decided, whatever the visitor", async () => {
    const cms = content();
    serve(forward({ "buy-button": true, dark: false }));
    expect(await bindDraft(cms)).toBe(false);
    expect((await contentClient(cms).resolve("BuyButton"))[0]).toBe("new");
    serve(forward({ "buy-button": false, dark: false }));
    await bindDraft(cms);
    expect((await contentClient(cms).resolve("BuyButton"))[0]).toBe("old");
  });

  it("on the release a test at 0% stays off whatever the header says; a preview may switch it on", async () => {
    const cms = content();
    serve(forward({ "buy-button": false, dark: true }));
    await bindDraft(cms);
    expect({ ...(await contentClient(cms).resolve("experiments"))[0]! }).toEqual({
      "buy-button": false,
      dark: false,
    });
    serve({ ...cookie, ...forward({ "buy-button": false, dark: true }) });
    expect(await bindDraft(cms)).toBe(true);
    expect(draftExperiments()).toEqual({ "buy-button": false, dark: true });
  });

  function draftExperiments(): Record<string, boolean> | undefined {
    const cms = { client: vi.fn((options: { experiments?: Record<string, boolean> }) => options) };
    return (contentClient(cms as never) as unknown as { experiments?: Record<string, boolean> })
      .experiments;
  }
});

describe("assignedClient: a page on the assignments route renders what its path says", () => {
  const content = snapshot({
    experiments: { "buy-button": 50, later: 0 },
    campaigns: {
      sale: { start: "2000-01-01T00:00:00Z" },
      "black-friday": { start: "2999-11-27T00:00:00Z" },
    },
  });
  const TESTS = ["buy-button", "later"];
  const CAMPAIGNS = ["sale", "black-friday"];
  /** The segment the proxy writes: every name of the content, on when listed (plus any extra names). */
  const seg = (experiments: string[], campaigns: string[] = []) => {
    const states = (all: string[], on: string[]) =>
      Object.fromEntries([...new Set([...all, ...on])].map((name) => [name, on.includes(name)]));
    return assignmentsSegment({
      experiments: states(TESTS, experiments),
      campaigns: states(CAMPAIGNS, campaigns),
    });
  };

  it("answers the tests from the path, with no visitor, and reads no request", async () => {
    const cms = testCMS(content);
    const on = await assignedClient(cms, seg(["buy-button"], ["sale"]));
    expect((await on!.resolve("BuyButton"))[0]).toBe("new");
    expect(on!.visitor).toBeNull();
    // A forged path can't switch on a test nobody is in (0%), and a name the content lacks stays off.
    const forged = await assignedClient(cms, seg(["buy-button", "later"]));
    expect({ ...(await forged!.resolve("experiments"))[0]! }).toEqual({
      "buy-button": true,
      later: false,
    });
    const off = await assignedClient(cms, seg([]));
    expect((await off!.resolve("BuyButton"))[0]).toBe("old");
    expect({ ...(await off!.resolve("experiments"))[0]! }).toEqual({
      "buy-button": false,
      later: false,
    });
    expect(request.reads).toBe(0);
  });

  it("renders the campaigns the path names, as the proxy decided them: no check of the dates at render time", async () => {
    const cms = testCMS(content);
    const cases: [string[], Record<string, boolean>][] = [
      [["sale"], { sale: true, "black-friday": false }],
      [[], { sale: false, "black-friday": false }],
      // The proxy decided at its moment: the page doesn't second-guess it.
      [["black-friday"], { sale: false, "black-friday": true }],
      [["gone"], { sale: false, "black-friday": false }],
    ];
    for (const [campaigns, expected] of cases) {
      const client = await assignedClient(cms, seg([], campaigns));
      expect({ ...(await client!.resolve("campaigns"))[0]! }).toEqual(expected);
    }
    expect(request.reads).toBe(0);
  });

  it("keeps a name the content doesn't have out, never an error; a malformed segment is null", async () => {
    const cms = testCMS(content);
    const client = await assignedClient(cms, seg(["buy-button", "gone"], ["sale", "gone"]));
    expect({ ...(await client!.resolve("experiments"))[0]! }).toEqual({
      "buy-button": true,
      later: false,
    });
    expect({ ...(await client!.resolve("campaigns"))[0]! }).toEqual({
      sale: true,
      "black-friday": false,
    });
    expect(await assignedClient(cms, "not-a-segment!")).toBeNull();
    const bare = await assignedClient(testCMS(), seg(["buy-button"], ["sale"])); // no experiments or campaigns block
    expect(bare).not.toBeNull();
  });
});
