// @vitest-environment node
/**
 * The app's half: `contentClient` reads what the worker decided, the draft on
 * `x-deco-draft` and the visitor's assignments on `x-deco-assignments`, and
 * the built-in `experiment` matcher answers with them.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeAssignments } from "../assignments.ts";
import { POINTER, snapshot, testCMS } from "../worker/testing.ts";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://store.example.com/"),
  setResponseHeader: () => {},
}));

const { contentClient, requestAssignments } = await import("./index.ts");

const page = (headers: Record<string, string> = {}) =>
  new Request("https://store.example.com/", { headers });

describe("contentClient", () => {
  it("the assignments the worker decided reach the experiment matcher", async () => {
    const cms = testCMS(snapshot({ experiments: { "buy-button": 50 } }));
    const inside = contentClient(cms, page({ "x-deco-assignments": "buy-button" }));
    expect((await inside.resolve("BuyButton"))[0]).toBe("new");
    const outside = contentClient(cms, page({ "x-deco-assignments": "" }));
    expect((await outside.resolve("BuyButton"))[0]).toBe("old");
    expect((await contentClient(cms, page()).resolve("BuyButton"))[0]).toBe("old");
  });

  it("the release's client gets them; a draft's gets none (the control, plus forced variants)", () => {
    const cms = { forDraft: vi.fn(() => "draft"), forRelease: vi.fn(() => "release") };
    contentClient(cms as never, page({ "x-deco-assignments": "a,b%2Cc" }));
    expect(cms.forRelease).toHaveBeenLastCalledWith({ assignments: { a: true, "b,c": true } });
    contentClient(cms as never, page());
    expect(cms.forRelease).toHaveBeenLastCalledWith();
    contentClient(cms as never, page({ "x-deco-draft": POINTER, "x-deco-assignments": "a" }));
    expect(cms.forDraft).toHaveBeenCalledWith(POINTER);
  });
});

describe("the assignments header", () => {
  it("round-trips the names a visitor is in, whatever they hold", () => {
    const names = { "buy-button": true, "a,b": true, "café %": true, __proto__x: true, off: false };
    const decoded = requestAssignments(page({ "x-deco-assignments": encodeAssignments(names) }));
    expect({ ...decoded }).toEqual({
      "buy-button": true,
      "a,b": true,
      "café %": true,
      __proto__x: true,
    });
  });

  it("null when the worker decided none; a part that doesn't decode is skipped", () => {
    expect(requestAssignments(page())).toBe(null);
    expect({ ...requestAssignments(page({ "x-deco-assignments": "%E0%A4%A,ok" })) }).toEqual({
      ok: true,
    });
  });
});
