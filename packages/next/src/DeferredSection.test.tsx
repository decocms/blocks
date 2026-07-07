import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { registerSectionsSync } from "@decocms/live/cms";
import { DeferredSectionBoundary } from "./DeferredSection";

function Hero({ label }: { label?: string }) {
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

describe("DeferredSectionBoundary (next)", () => {
  it("renders the fallback while the promise is pending, per Suspense semantics", () => {
    const KEY = "site/sections/NextDeferredA.tsx";
    registerSectionsSync({ [KEY]: { default: Hero } });

    const neverResolves = new Promise<any>(() => {});
    const html = renderToString(
      <DeferredSectionBoundary
        deferred={{ key: KEY, component: KEY, index: 0 } as any}
        promise={neverResolves}
        pagePath="/"
        fallback={<div>loading</div>}
      />,
    );
    expect(html).toContain("loading");
    expect(html).not.toContain("hero-");
  });
});
