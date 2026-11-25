// @vitest-environment node
/**
 * `loadDeferredSection` is a public POST server function that still accepts
 * deprecated client-supplied `rawProps`. Those props come from the request,
 * so a server-only resolve type in them (e.g. `vtex/actions/masterData/*`,
 * which runs with the store's appKey) must be refused — while props from the
 * deferred cache / the published page keep resolving normally.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal createServerFn builder: `.inputValidator().handler(fn)` → fn itself,
// so the export can be called with `{ data }` like the real RPC envelope.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: any = {
      inputValidator: () => builder,
      handler: (fn: (ctx: unknown) => unknown) => fn,
    };
    return builder;
  },
}));

vi.mock("@tanstack/react-start/server", () => ({
  getCookies: () => ({}),
  getRequest: () => new Request("http://localhost/"),
  getRequestHeader: () => "",
  getRequestUrl: () => new URL("http://localhost/"),
  setCookie: () => {},
  setResponseHeader: () => {},
}));

import {
  cacheDeferredRawProps,
  clearServerOnlyResolveTypes,
  registerCommerceLoaders,
  registerSection,
  registerSectionLoaders,
  registerServerOnlyResolveTypes,
  resolveDeferred,
  setBlocks,
} from "@decocms/blocks/cms";
import { loadDeferredSection } from "./cmsRoute";

const SECTION = "site/sections/Probe.tsx";
const secret = vi.fn(async () => ({ leaked: true }));
const pub = vi.fn(async () => ({ ok: true }));

const call = (data: Record<string, unknown>) =>
  (loadDeferredSection as unknown as (ctx: { data: unknown }) => Promise<any>)({
    data: { component: SECTION, pagePath: "/", ...data },
  }).catch((e: unknown) => e);

beforeEach(() => {
  secret.mockClear();
  pub.mockClear();
  setBlocks({});
  registerSection(SECTION, async () => ({ default: () => null }));
  registerCommerceLoaders({ "fake/actions/secret": secret, "fake/loaders/public": pub });
  clearServerOnlyResolveTypes("persistent");
  registerServerOnlyResolveTypes(["fake/actions/secret"]);
});

describe("loadDeferredSection client rawProps", () => {
  it("still resolves a public loader (control)", async () => {
    const section = await call({ rawProps: { x: { __resolveType: "fake/loaders/public" } } });
    expect(pub).toHaveBeenCalledTimes(1);
    expect(section?.props?.x).toEqual({ ok: true });
  });

  it.each([
    ["top-level", { x: { __resolveType: "fake/actions/secret" } }],
    ["with .ts suffix", { x: { __resolveType: "fake/actions/secret.ts" } }],
    ["nested", { a: [{ b: { __resolveType: "fake/actions/secret" } }] }],
  ])("refuses a server-only resolve type (%s)", async (_label, rawProps) => {
    await call({ rawProps });
    expect(secret).not.toHaveBeenCalled();
  });

  it("keeps resolving server-only types from trusted (cached page) props", async () => {
    cacheDeferredRawProps("/", SECTION, 3, { x: { __resolveType: "fake/actions/secret" } });
    const section = await call({ index: 3 });
    expect(secret).toHaveBeenCalledTimes(1);
    expect(section?.props?.x).toEqual({ leaked: true });
  });
});

describe("loadDeferredSection deferred-prop thunks", () => {
  const THUNK_SECTION = "site/sections/ThunkProbe.tsx";

  beforeEach(() => {
    registerSection(THUNK_SECTION, async () => ({ default: () => null }));
    // The documented asResolved(…, true) pattern: the section loader resolves
    // the deferred prop itself — after loadDeferredSection's resolve returned.
    registerSectionLoaders({
      [THUNK_SECTION]: async (props: any) => ({ ...props, d: await resolveDeferred(props.d) }),
    });
  });

  const thunk = (resolveType: string) => ({
    d: { __resolveType: "resolved", deferred: true, data: { __resolveType: resolveType } },
  });

  it("still resolves a public loader through a thunk (control)", async () => {
    const section = await call({
      component: THUNK_SECTION,
      rawProps: thunk("fake/loaders/public"),
    });
    expect(pub).toHaveBeenCalledTimes(1);
    expect(section?.props?.d).toEqual({ ok: true });
  });

  it("refuses a server-only type smuggled through a client thunk", async () => {
    await call({ component: THUNK_SECTION, rawProps: thunk("fake/actions/secret") });
    expect(secret).not.toHaveBeenCalled();
  });

  it("trusted (cached page) thunks still reach server-only types", async () => {
    cacheDeferredRawProps("/", THUNK_SECTION, 7, thunk("fake/actions/secret"));
    const section = await call({ component: THUNK_SECTION, index: 7 });
    expect(secret).toHaveBeenCalledTimes(1);
    expect(section?.props?.d).toEqual({ leaked: true });
  });
});
