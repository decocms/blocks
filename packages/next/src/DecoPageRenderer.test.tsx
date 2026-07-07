import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { registerSectionsSync } from "@decocms/runtime/cms";
import { DecoPageRenderer } from "./DecoPageRenderer";

function Hero({ label }: { label?: string }) {
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

describe("DecoPageRenderer (next)", () => {
  it("renders eager sections in order", async () => {
    registerSectionsSync({
      "site/sections/NextPageA.tsx": { default: Hero },
      "site/sections/NextPageB.tsx": { default: Hero },
    });

    const element = await DecoPageRenderer({
      sections: [
        { key: "site/sections/NextPageA.tsx", component: "site/sections/NextPageA.tsx", props: { label: "first" }, index: 0 } as any,
        { key: "site/sections/NextPageB.tsx", component: "site/sections/NextPageB.tsx", props: { label: "second" }, index: 1 } as any,
      ],
      pagePath: "/",
    });
    const html = renderToString(element);
    expect(html.indexOf("hero-first")).toBeLessThan(html.indexOf("hero-second"));
  });
});
