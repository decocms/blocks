// @vitest-environment node
/**
 * The app's half: `contentClient` reads what the worker decided, the version
 * on `x-deco-draft` and the visitor on `x-deco-visitor`, and builds
 * `cms.client({ visitor, version })` from them.
 */
import { newVisitor, serializeVisitor, type Visitor } from "@decocms/blocks/experiments";
import { describe, expect, it, vi } from "vitest";
import { POINTER, snapshot, testCMS } from "../worker/testing.ts";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://store.example.com/"),
  setResponseHeader: () => {},
}));

const { contentClient, requestDraft, requestVisitor } = await import("./index.ts");

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

  it("is cms.client({ visitor, version }) with what the worker forwarded", () => {
    const cms = { client: vi.fn(() => "client") };
    const visitor: Visitor = newVisitor();
    contentClient(
      cms as never,
      page({ "x-deco-draft": POINTER, "x-deco-visitor": serializeVisitor(visitor) }),
    );
    expect(cms.client).toHaveBeenLastCalledWith({ visitor, version: POINTER });
    contentClient(cms as never, page());
    expect(cms.client).toHaveBeenLastCalledWith({ visitor: null, version: null });
  });
});

describe("the forwarded headers", () => {
  it("requestDraft reads the version on x-deco-draft (a draft pointer or a release SHA)", () => {
    expect(requestDraft(page({ "x-deco-draft": POINTER }))).toBe(POINTER);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(requestDraft(page({ "x-deco-draft": sha }))).toBe(sha);
    expect(requestDraft(page())).toBe(null);
  });

  it("requestVisitor is null without the header or when it doesn't read", () => {
    expect(requestVisitor(page())).toBe(null);
    expect(requestVisitor(page({ "x-deco-visitor": "junk" }))).toBe(null);
  });
});
