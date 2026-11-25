// @vitest-environment node
/**
 * withUntrustedResolveInput: server-only resolve types are refused for
 * request-driven input — including through a deferred thunk that is called
 * after the scope has exited (e.g. by a section loader via resolveDeferred).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearServerOnlyResolveTypes,
  registerCommerceLoaders,
  registerServerOnlyResolveTypes,
  resolveDeferred,
  resolveValue,
  withUntrustedResolveInput,
} from "./index";

const secret = vi.fn(async () => ({ leaked: true }));

beforeEach(() => {
  secret.mockClear();
  registerCommerceLoaders({ "probe/actions/secret": secret });
  clearServerOnlyResolveTypes("persistent");
  registerServerOnlyResolveTypes(["probe/actions/secret"]);
});

const thunkProp = {
  __resolveType: "resolved",
  deferred: true,
  data: { __resolveType: "probe/actions/secret" },
};

describe("withUntrustedResolveInput", () => {
  it("refuses a server-only type resolved directly in scope", async () => {
    await expect(
      withUntrustedResolveInput(() => resolveValue({ __resolveType: "probe/actions/secret" })),
    ).rejects.toThrow(/server-only/);
    expect(secret).not.toHaveBeenCalled();
  });

  it("refuses it through a thunk invoked after the scope exited", async () => {
    const thunk = await withUntrustedResolveInput(() => resolveValue(thunkProp));
    await expect(resolveDeferred(thunk as any)).rejects.toThrow(/server-only/);
    expect(secret).not.toHaveBeenCalled();
  });

  it("does not affect trusted resolution, thunks included", async () => {
    expect(await resolveValue({ __resolveType: "probe/actions/secret" })).toEqual({ leaked: true });
    const thunk = await resolveValue(thunkProp);
    expect(await resolveDeferred(thunk as any)).toEqual({ leaked: true });
  });

  it("ignores the persistent/app scope split for enforcement", async () => {
    clearServerOnlyResolveTypes("persistent");
    registerServerOnlyResolveTypes(["probe/actions/secret"], "app");
    await expect(
      withUntrustedResolveInput(() => resolveValue({ __resolveType: "probe/actions/secret.ts" })),
    ).rejects.toThrow(/server-only/);
    clearServerOnlyResolveTypes("app");
  });
});
