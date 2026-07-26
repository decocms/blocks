import { describe, expect, it } from "vitest";
import { upgradeFileToV7 } from "./upgrade-6-to-7";

describe("upgradeFileToV7 (#367) — simple 1:1 specifier rewrites", () => {
  it("rewrites @decocms/start/vite", () => {
    const r = upgradeFileToV7(`import { decoVitePlugin } from "@decocms/start/vite";`);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`import { decoVitePlugin } from "@decocms/tanstack/vite";`);
  });

  it("rewrites @decocms/start/sdk/cookiePassthrough", () => {
    const r = upgradeFileToV7(
      `import { getRequestCookieHeader } from "@decocms/start/sdk/cookiePassthrough";`,
    );
    expect(r.content).toBe(
      `import { getRequestCookieHeader } from "@decocms/tanstack/sdk/cookiePassthrough";`,
    );
  });

  it("rewrites @decocms/start/sdk/workerEntry and sdk/router to @decocms/tanstack root", () => {
    const r = upgradeFileToV7(
      [
        `import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";`,
        `import { createDecoRouter } from "@decocms/start/sdk/router";`,
      ].join("\n"),
    );
    expect(r.content).toBe(
      [
        `import { createDecoWorkerEntry } from "@decocms/tanstack";`,
        `import { createDecoRouter } from "@decocms/tanstack";`,
      ].join("\n"),
    );
  });

  it("rewrites generic @decocms/start/sdk/* to @decocms/blocks/sdk/*", () => {
    const r = upgradeFileToV7(
      [
        `import { useScript } from "@decocms/start/sdk/useScript";`,
        `import { useDevice } from "@decocms/start/sdk/useDevice";`,
        `import { clx } from "@decocms/start/sdk/clx";`,
      ].join("\n"),
    );
    expect(r.content).toBe(
      [
        `import { useScript } from "@decocms/blocks/sdk/useScript";`,
        `import { useDevice } from "@decocms/blocks/sdk/useDevice";`,
        `import { clx } from "@decocms/blocks/sdk/clx";`,
      ].join("\n"),
    );
  });

  it("rewrites @decocms/start/cms, /setup, /types/widgets, /admin", () => {
    const r = upgradeFileToV7(
      [
        `import { resolveDecoPage } from "@decocms/start/cms";`,
        `import { createSiteSetup } from "@decocms/start/setup";`,
        `import type { ImageWidget } from "@decocms/start/types/widgets";`,
        `import { handleMeta } from "@decocms/start/admin";`,
      ].join("\n"),
    );
    expect(r.content).toContain(`from "@decocms/blocks/cms"`);
    expect(r.content).toContain(`from "@decocms/blocks/setup"`);
    expect(r.content).toContain(`from "@decocms/blocks/types/widgets"`);
    expect(r.content).toContain(`from "@decocms/blocks-admin"`);
  });

  it("rewrites @decocms/apps/commerce/components/Image to @decocms/blocks/hooks", () => {
    const r = upgradeFileToV7(`import { Image } from "@decocms/apps/commerce/components/Image";`);
    expect(r.content).toBe(`import { Image } from "@decocms/blocks/hooks";`);
  });

  it("rewrites @decocms/apps/commerce/* to @decocms/apps-commerce/*", () => {
    const r = upgradeFileToV7(`import type { Product } from "@decocms/apps/commerce/types";`);
    expect(r.content).toBe(`import type { Product } from "@decocms/apps-commerce/types";`);
  });

  it("rewrites @decocms/apps/vtex/* to @decocms/apps-vtex/*", () => {
    const r = upgradeFileToV7(`import { getUser } from "@decocms/apps/vtex/loaders/user";`);
    expect(r.content).toBe(`import { getUser } from "@decocms/apps-vtex/loaders/user";`);
  });

  it("is a no-op for a file already on the 7.x split packages", () => {
    const src = `import { createDecoWorkerEntry } from "@decocms/tanstack";\nimport { resolveDecoPage } from "@decocms/blocks/cms";\n`;
    const r = upgradeFileToV7(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
    expect(r.notes).toEqual([]);
  });
});

describe("upgradeFileToV7 (#367) — @decocms/start/routes fan-out", () => {
  it("moves cmsRouteConfig/cmsHomeRouteConfig to @decocms/tanstack root", () => {
    const r = upgradeFileToV7(
      `import { cmsRouteConfig, cmsHomeRouteConfig } from "@decocms/start/routes";`,
    );
    expect(r.content).toBe(
      `import { cmsRouteConfig, cmsHomeRouteConfig } from "@decocms/tanstack";`,
    );
  });

  it("splits deferredSectionLoader into its own subpath import", () => {
    const r = upgradeFileToV7(
      `import { cmsRouteConfig, deferredSectionLoader } from "@decocms/start/routes";`,
    );
    expect(r.content).toContain(`import { cmsRouteConfig } from "@decocms/tanstack";`);
    expect(r.content).toContain(
      `import { deferredSectionLoader } from "@decocms/tanstack/sdk/deferredSectionLoader";`,
    );
  });

  it("renames decoMetaRoute/decoRenderRoute/decoInvokeRoute to their *RouteConfig factory names and flags a MANUAL call-site note", () => {
    const src = [
      `import { decoMetaRoute, decoRenderRoute, decoInvokeRoute } from "@decocms/start/routes";`,
      `export const Route = createFileRoute("/deco/meta")({ ...decoMetaRoute });`,
    ].join("\n");
    const r = upgradeFileToV7(src);
    expect(r.content).toContain(
      `import { decoMetaRouteConfig, decoRenderRouteConfig, decoInvokeRouteConfig } from "@decocms/tanstack";`,
    );
    expect(r.content).toContain("...decoMetaRouteConfig }");
    expect(r.notes.some((n) => n.includes("decoMetaRoute") && n.includes("factory"))).toBe(true);
  });
});

describe("upgradeFileToV7 (#367) — @decocms/start/hooks fan-out", () => {
  it("moves DecoPageRenderer/DecoRootLayout/PreviewProviders to @decocms/tanstack root", () => {
    const r = upgradeFileToV7(
      `import { DecoPageRenderer, DecoRootLayout, PreviewProviders } from "@decocms/start/hooks";`,
    );
    expect(r.content).toBe(
      `import { DecoPageRenderer, DecoRootLayout, PreviewProviders } from "@decocms/tanstack";`,
    );
  });

  it("renames RenderSection to SectionRenderer at the import and every usage", () => {
    const src = [
      `import { RenderSection } from "@decocms/start/hooks";`,
      `export const x = <RenderSection section={s} />;`,
    ].join("\n");
    const r = upgradeFileToV7(src);
    expect(r.content).toContain(`import { SectionRenderer } from "@decocms/tanstack";`);
    expect(r.content).toContain("<SectionRenderer section={s} />");
    expect(r.content).not.toContain("RenderSection");
  });
});
