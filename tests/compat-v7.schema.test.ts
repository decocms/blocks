// @vitest-environment node
/**
 * `@decocms/compat-v7`'s widget aliases keep v7's site-editor widgets:
 * `deco schema` reads the alias by name, so a prop typed with an alias
 * imported from the package gets the same field as v7 gave it (an image
 * picker for `ImageWidget`, `Secret` a "password" string, …). One follows
 * v8's generator rather than v7's: `Color` is format "color" (v7 wrote
 * "color-input", which the site editor renders the same way). Runs the
 * generator on a temp app that installs the package (the workspace's
 * node_modules, so the built dist/ types, as a site would see them). The
 * matchers keep their fields when the site wraps them in its block map.
 */
import { describe, expect, it } from "vitest";
import { createFixture } from "../packages/blocks/src/v8/cli/__tests__/fixture";
import { decoPaths } from "../packages/blocks/src/v8/cli/root";
import { generateSchema } from "../packages/blocks/src/v8/cli/schema/generate";
import { toBase64 } from "../packages/blocks/src/v8/cli/schema/typeToSchema";

describe("@decocms/compat-v7 widget aliases in deco schema", () => {
  it.each([
    "@decocms/compat-v7/types/widgets",
    "@decocms/compat-v7/types",
    "@decocms/compat-v7",
  ])("from %s: each alias gives its widget", async (from) => {
    const fixture = createFixture({
      "src/banner.ts": `
import type { ButtonWidget, Color, HTMLWidget, ImageWidget, RichText, Secret, TextArea, TextWidget, VideoWidget } from "${from}";
export interface Props {
  image: ImageWidget;
  images?: ImageWidget[];
  video?: VideoWidget;
  html?: HTMLWidget;
  rich?: RichText;
  color?: Color;
  area?: TextArea;
  text?: TextWidget;
  button?: ButtonWidget;
  apiKey?: Secret;
}
export const banner = (props: Props) => ({ component: "banner", props });`,
      ".deco/index.ts": `import { banner } from "../src/banner"; export default { banner };`,
    });
    try {
      const { meta, diagnostics } = await generateSchema(decoPaths(fixture.root));
      expect(diagnostics).toEqual([]);
      const p = meta.schema.definitions[`${toBase64("banner")}@Props`]?.properties;
      expect(p, Object.keys(meta.schema.definitions).join(" ")).toBeDefined();
      expect(p.image).toMatchObject({ type: "string", format: "image-uri" });
      expect(p.images.items).toMatchObject({ type: "string", format: "image-uri" });
      expect(p.video).toMatchObject({ type: "string", format: "video-uri" });
      expect(p.html).toMatchObject({ type: "string", format: "html" });
      expect(p.rich).toMatchObject({ type: "string", format: "rich-text" });
      expect(p.color).toMatchObject({ type: "string", format: "color" });
      expect(p.area).toMatchObject({ type: "string", format: "textarea" });
      // v7 gave these two no widget either: a plain text field.
      expect(p.text).toMatchObject({ type: "string" });
      expect(p.text.format).toBeUndefined();
      expect(p.button.format).toBeUndefined();
      // v7's masked text box: a plain string (real secrets live in the deploy platform).
      expect(p.apiKey).toEqual(expect.objectContaining({ type: "string", format: "password" }));
    } finally {
      fixture.remove();
    }
  }, 60_000);
});

describe("@decocms/compat-v7 matchers in deco schema", () => {
  it("a matcher wrapped in the block map gets v7's fields, and random its cohort", async () => {
    const fixture = createFixture({
      "src/matchers.ts": `
import { type DeviceProps, device, type RandomProps, random } from "@decocms/compat-v7/matchers";
declare const request: Request;
export const matchers = {
  "website/matchers/device.ts": (props: DeviceProps) => device(props, request),
  "website/matchers/random.ts": (props: RandomProps) => random(props, request),
};`,
      ".deco/index.ts": `import { matchers } from "../src/matchers"; export default { ...matchers };`,
    });
    try {
      const { meta, diagnostics } = await generateSchema(decoPaths(fixture.root));
      expect(diagnostics).toEqual([]);
      const defs = meta.schema.definitions;
      const find = (name: string) =>
        Object.entries(defs).find(([key]) => key.startsWith(toBase64(name)))?.[1] as
          | { properties: Record<string, { type?: string; title?: string }> }
          | undefined;
      const random = find("website/matchers/random.ts");
      expect(random, Object.keys(defs).join(" ")).toBeDefined();
      expect(random?.properties.traffic).toMatchObject({ type: "number", title: "Traffic share" });
      expect(random?.properties.cohort).toMatchObject({ type: "string", title: "Cohort" });
      const deviceProps = find("website/matchers/device.ts")?.properties;
      expect(Object.keys(deviceProps ?? {}).sort()).toEqual([
        "__resolveType",
        "desktop",
        "mobile",
        "tablet",
      ]);
    } finally {
      fixture.remove();
    }
  }, 60_000);
});
