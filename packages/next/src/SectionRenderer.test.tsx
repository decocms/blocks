import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSection, registerSections, registerSectionsSync } from "@decocms/live/cms";
import { SectionRenderer } from "./SectionRenderer";

function Hero({ label }: { label?: string }) {
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

// The test environment runs under jsdom (see root vitest.config.ts), where
// `window` is defined. next/dynamic's internals branch on
// `typeof window === "undefined"` to decide server vs. client behavior, so
// under jsdom it always takes the client path — `{ ssr: false }` vs.
// `{ ssr: true }` produce IDENTICAL rendered output here (both effectively
// render `null` during a synchronous renderToString call, since the loader's
// promise can't resolve in time regardless of the ssr option). Asserting on
// rendered HTML would therefore pass even if ClientOnlySection passed
// `{ ssr: true }` by mistake — it exercises no real server/window-undefined
// code path in this environment.
//
// Instead we verify the actual contract ClientOnlySection is responsible
// for: that it calls next/dynamic with `{ ssr: false }`. We spy on the
// `next/dynamic` module import via `vi.mock` + `vi.hoisted`.
const { dynamicSpy } = vi.hoisted(() => ({ dynamicSpy: vi.fn() }));

vi.mock("next/dynamic", () => ({
  default: (loader: unknown, options: unknown) => {
    dynamicSpy(loader, options);
    return function DynamicStub() {
      return null;
    };
  },
}));

beforeEach(() => {
  dynamicSpy.mockClear();
});

describe("SectionRenderer (next)", () => {
  it("renders a sync-registered section directly", async () => {
    const KEY = "site/sections/NextSyncA.tsx";
    registerSectionsSync({ [KEY]: { default: Hero } });

    const element = await SectionRenderer({
      resolved: { key: KEY, component: KEY, props: { label: "a" } } as any,
    });
    const html = renderToString(element);
    expect(html).toContain("hero-a");
  });

  it("awaits a code-split (non-sync) section's loader", async () => {
    const KEY = "site/sections/NextLazyA.tsx";
    registerSections({ [KEY]: () => Promise.resolve({ default: Hero }) });

    const element = await SectionRenderer({
      resolved: { key: KEY, component: KEY, props: { label: "b" } } as any,
    });
    const html = renderToString(element);
    expect(html).toContain("hero-b");
  });

  it("routes a clientOnly-registered section through next/dynamic with ssr:false", async () => {
    const KEY = "site/sections/NextClientOnlyA.tsx";
    const loader = () => Promise.resolve({ default: Hero });
    registerSection(KEY, loader, { clientOnly: true });

    const element = await SectionRenderer({
      resolved: { key: KEY, component: KEY, props: { label: "c" } } as any,
    });
    const html = renderToString(element);

    // The actual contract: ClientOnlySection must call next/dynamic with
    // { ssr: false } for this section's loader. This fails if the
    // implementation is changed to pass { ssr: true } (or omits the option).
    expect(dynamicSpy).toHaveBeenCalledWith(loader, { ssr: false });

    // The section shell (wrapping <section> + manifest key) still renders
    // server-side regardless of the dynamic child's ssr option.
    expect(html).toContain(`data-manifest-key="${KEY}"`);
  });

  it("warns and renders nothing for an unregistered section", async () => {
    const KEY = "site/sections/NextMissingA.tsx";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const element = await SectionRenderer({
      resolved: { key: KEY, component: KEY, props: {} } as any,
    });

    expect(element).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`No component registered for: ${KEY}`),
    );

    warnSpy.mockRestore();
  });
});
