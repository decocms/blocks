/**
 * Contract test for the public `deferredSectionLoader` wrapper
 * (`@decocms/tanstack/sdk/deferredSectionLoader`).
 *
 * Before 7.7 this wrapper was unreachable from any public subpath, so
 * migrated sites (lebiscuit, miess, granadobr, casaevideo) each carried a
 * byte-identical local shim wrapping the public `loadDeferredSection`
 * export. The cases below are derived from how those sites call it: it is
 * passed verbatim as `<DecoPageRenderer loadDeferredSectionFn={...} />`,
 * so it must (a) accept the renderer's flat argument object, (b) wrap it
 * into the server function's `{ data }` envelope, and (c) pass the result
 * (section or null) straight through.
 */
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("../routes/cmsRoute", () => ({
  loadDeferredSection: vi.fn(),
}));

import type { DecoPageRenderer } from "../hooks/DecoPageRenderer";
import { loadDeferredSection } from "../routes/cmsRoute";
import { deferredSectionLoader } from "./deferredSectionLoader";

const mockedLoad = loadDeferredSection as unknown as ReturnType<typeof vi.fn>;

describe("deferredSectionLoader", () => {
  beforeEach(() => {
    mockedLoad.mockReset();
  });

  it("wraps the flat argument object into the server function's { data } envelope", async () => {
    const section = { component: "site/sections/Newsletter.tsx", props: {} };
    mockedLoad.mockResolvedValue(section);

    const result = await deferredSectionLoader({
      component: "site/sections/Newsletter.tsx",
      rawProps: { title: "Hi" },
      pagePath: "/",
      pageUrl: "https://example.com/?utm=x",
      index: 4,
    });

    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(mockedLoad).toHaveBeenCalledWith({
      data: {
        component: "site/sections/Newsletter.tsx",
        rawProps: { title: "Hi" },
        pagePath: "/",
        pageUrl: "https://example.com/?utm=x",
        index: 4,
      },
    });
    expect(result).toBe(section);
  });

  it("accepts the minimal call shape (component + pagePath only)", async () => {
    mockedLoad.mockResolvedValue(null);

    await deferredSectionLoader({
      component: "site/sections/Footer.tsx",
      pagePath: "/collections/sale",
    });

    expect(mockedLoad).toHaveBeenCalledWith({
      data: {
        component: "site/sections/Footer.tsx",
        rawProps: undefined,
        pagePath: "/collections/sale",
        pageUrl: undefined,
        index: undefined,
      },
    });
  });

  it("passes a null resolution (cache miss / unresolvable section) straight through", async () => {
    mockedLoad.mockResolvedValue(null);

    const result = await deferredSectionLoader({
      component: "site/sections/Missing.tsx",
      pagePath: "/",
      index: 0,
    });

    expect(result).toBeNull();
  });

  it("matches DecoPageRenderer's loadDeferredSectionFn prop signature", () => {
    // The whole point of the export: sites pass it verbatim as
    // `<DecoPageRenderer loadDeferredSectionFn={deferredSectionLoader} />`.
    type LoadFn = NonNullable<ComponentProps<typeof DecoPageRenderer>["loadDeferredSectionFn"]>;
    expectTypeOf(deferredSectionLoader).toExtend<LoadFn>();
  });
});
