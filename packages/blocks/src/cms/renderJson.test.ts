import { describe, expect, it } from "vitest";
import { type RenderJsonModule, serializeRenderJson } from "./renderJson";

const modules: Record<string, RenderJsonModule> = {
  "site/sections/Product/ProductDetails.tsx": {
    renderJson: ({ storeConfig: _s, ...rest }) => rest,
  },
  "site/sections/Theme/Theme.tsx": { renderJson: false },
  "site/sections/Footer/Footer.tsx": {}, // no renderJson → full props
};
const getSectionModule = (c: string) => modules[c];

describe("serializeRenderJson", () => {
  it("applies a projection function to the props", () => {
    const out = serializeRenderJson(
      [{ component: "site/sections/Product/ProductDetails.tsx", props: { storeConfig: {}, page: 1 } }],
      { getSectionModule },
    );
    expect(out).toEqual([
      { component: "site/sections/Product/ProductDetails.tsx", props: { page: 1 } },
    ]);
  });

  it("drops sections whose module exports renderJson === false", () => {
    const out = serializeRenderJson(
      [
        { component: "site/sections/Theme/Theme.tsx", props: { x: 1 } },
        { component: "site/sections/Footer/Footer.tsx", props: { y: 2 } },
      ],
      { getSectionModule },
    );
    expect(out).toEqual([{ component: "site/sections/Footer/Footer.tsx", props: { y: 2 } }]);
  });

  it("passes full props through when there is no renderJson export", () => {
    const out = serializeRenderJson([{ component: "site/sections/Footer/Footer.tsx", props: { y: 2 } }], {
      getSectionModule,
    });
    expect(out).toEqual([{ component: "site/sections/Footer/Footer.tsx", props: { y: 2 } }]);
  });

  it("drops sections by sectionsToIgnore suffix match on resolveType", () => {
    const out = serializeRenderJson(
      [
        { component: "website/sections/Seo/SeoV2.tsx", props: { title: "x" } },
        { component: "site/sections/Footer/Footer.tsx", props: { y: 2 } },
      ],
      { getSectionModule, sectionsToIgnore: ["SeoV2.tsx"] },
    );
    expect(out).toEqual([{ component: "site/sections/Footer/Footer.tsx", props: { y: 2 } }]);
  });

  it("ignores blank sectionsToIgnore entries (a '' suffix must not drop everything)", () => {
    const out = serializeRenderJson(
      [{ component: "site/sections/Footer/Footer.tsx", props: { y: 2 } }],
      { getSectionModule, sectionsToIgnore: ["", "  "] },
    );
    expect(out).toHaveLength(1);
  });

  it("keeps full props when no getSectionModule is provided", () => {
    const out = serializeRenderJson([{ component: "a", props: { z: 1 } }]);
    expect(out).toEqual([{ component: "a", props: { z: 1 } }]);
  });

  it("defaults missing props to an empty object", () => {
    const out = serializeRenderJson([{ component: "a" }]);
    expect(out).toEqual([{ component: "a", props: {} }]);
  });
});
