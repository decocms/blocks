import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERNAL_ACTIONS,
  isInternalAction,
} from "./invokePolicy";

describe("invokePolicy — isInternalAction", () => {
  it("denies the built-in generic MasterData CRUD actions by default", () => {
    for (const name of DEFAULT_INTERNAL_ACTIONS) {
      expect(isInternalAction(name)).toBe(true);
    }
  });

  it("matches both key shapes the two exposure machines produce", () => {
    // Machine 1 (invoke.gen.ts) keys are bare function names.
    expect(isInternalAction("searchDocuments")).toBe(true);
    // Machine 2 (setupApps) keys are module-path/fnName.
    expect(isInternalAction("vtex/actions/masterData/searchDocuments")).toBe(true);
    // .ts aliases the registrar also emits.
    expect(isInternalAction("vtex/actions/masterData/searchDocuments.ts")).toBe(true);
  });

  it("allows ordinary actions", () => {
    expect(isInternalAction("getOrCreateCart")).toBe(false);
    expect(isInternalAction("vtex/actions/checkout/addItemsToCart")).toBe(false);
    expect(isInternalAction("subscribe")).toBe(false);
  });

  it("honors a site-provided deny list (bare or full key)", () => {
    expect(isInternalAction("dangerousThing", { deny: ["dangerousThing"] })).toBe(true);
    expect(
      isInternalAction("site/actions/dangerousThing", { deny: ["dangerousThing"] }),
    ).toBe(true);
    expect(isInternalAction("safeThing", { deny: ["dangerousThing"] })).toBe(false);
  });

  it("lets an explicit allow entry override the default denylist", () => {
    expect(isInternalAction("searchDocuments", { allow: ["searchDocuments"] })).toBe(false);
    expect(
      isInternalAction("vtex/actions/masterData/searchDocuments", {
        allow: ["searchDocuments"],
      }),
    ).toBe(false);
  });

  it("allow is surgical — only the named action is re-opened", () => {
    const policy = { allow: ["searchDocuments"] };
    expect(isInternalAction("searchDocuments", policy)).toBe(false);
    expect(isInternalAction("createDocument", policy)).toBe(true);
  });

  it("allow wins over an explicit deny too", () => {
    expect(
      isInternalAction("thing", { deny: ["thing"], allow: ["thing"] }),
    ).toBe(false);
  });
});
