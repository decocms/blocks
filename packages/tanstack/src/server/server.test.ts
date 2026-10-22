// @vitest-environment node
/**
 * The app's half: `contentClient` reads what the worker decided, the version
 * on `x-deco-version`, the visitor on `x-deco-visitor` and the tests and
 * campaigns on `x-deco-assignments`, and builds
 * `cms.client({ version, experiments, campaigns })` from them.
 */
import { newVisitor, serializeVisitor, type Visitor } from "@decocms/blocks/experiments";
import { describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../worker/testing.ts";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://store.example.com/"),
  setResponseHeader: () => {},
}));

const { contentClient, requestAssignments, requestVersion, requestVisitor } = await import(
  "./index.ts"
);

const page = (headers: Record<string, string> = {}) =>
  new Request("https://store.example.com/", { headers });

describe("contentClient", () => {
  it("the visitor the worker read decides the tests", async () => {
    const cms = testCMS(snapshot({ experiments: { "buy-button": 100 } }));
    const visitor = serializeVisitor(newVisitor());
    const client = contentClient(cms, page({ "x-deco-visitor": visitor }));
    expect((await client.resolve("BuyButton"))[0]).toBe("new");
    expect(client.visitor?.id).toBe(requestVisitor(page({ "x-deco-visitor": visitor }))?.id);
    // Without a visitor every test is off.
    expect((await contentClient(cms, page()).resolve("BuyButton"))[0]).toBe("old");
  });

  it("is cms.client({ version, experiments, campaigns }) with what the worker forwarded", () => {
    const cms = { client: vi.fn(() => "client") };
    const visitor: Visitor = newVisitor();
    contentClient(
      cms as never,
      page({
        "x-deco-version": POINTER,
        "x-deco-visitor": serializeVisitor(visitor),
        "x-deco-assignments": "x=+a,-b|c=-sale",
      }),
    );
    expect(cms.client).toHaveBeenLastCalledWith({
      version: POINTER,
      visitor,
      experiments: { a: true, b: false },
      campaigns: { sale: false },
    });
    contentClient(cms as never, page());
    expect(cms.client).toHaveBeenLastCalledWith({
      version: null,
      visitor: null,
      experiments: undefined,
      campaigns: undefined,
    });
  });

  it("the worker's decisions win over the visitor: the page decides nothing again", async () => {
    const cms = testCMS(snapshot({ experiments: { "buy-button": 100 } }));
    const visitor = serializeVisitor(newVisitor());
    const client = contentClient(
      cms,
      page({ "x-deco-visitor": visitor, "x-deco-assignments": "x=-buy-button" }),
    );
    expect((await client.resolve("BuyButton"))[0]).toBe("old");
  });
});

describe("the forwarded headers", () => {
  it("requestVersion reads the version on x-deco-version (a draft pointer or a release SHA)", () => {
    expect(requestVersion(page({ "x-deco-version": POINTER }))).toBe(POINTER);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(requestVersion(page({ "x-deco-version": sha }))).toBe(sha);
    expect(requestVersion(page())).toBe(null);
  });

  it("requestAssignments is null without the header or when it doesn't read", () => {
    expect(requestAssignments(page())).toBe(null);
    expect(requestAssignments(page({ "x-deco-assignments": "junk" }))).toBe(null);
    expect(requestAssignments(page({ "x-deco-assignments": "-" }))).toEqual({
      experiments: {},
      campaigns: {},
    });
  });

  it("requestVisitor is null without the header or when it doesn't read", () => {
    expect(requestVisitor(page())).toBe(null);
    expect(requestVisitor(page({ "x-deco-visitor": "junk" }))).toBe(null);
  });
});
