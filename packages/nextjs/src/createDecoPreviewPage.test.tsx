// @vitest-environment node

import { registerSection, setBlocks } from "@decocms/blocks/cms";
import { setRenderShell } from "@decocms/blocks-admin";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoPreviewPage } from "./createDecoPreviewPage";
import * as nextjs from "./index";

vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        host: "store.test",
        "x-forwarded-proto": "https",
        "user-agent": "preview-test",
      }),
  ),
}));

const HERO = "site/sections/PreviewHero.tsx";

beforeEach(() => {
  setBlocks({
    "Preview Hero": { __resolveType: HERO, label: "rsc" },
  });
  registerSection(HERO, async () => ({
    default: ({ label }: { label?: string }) => <h1>{`hero-${label}`}</h1>,
  }));
  setRenderShell({
    css: "/preview.css",
    fonts: ["/font.css"],
    theme: "light",
    bodyClass: "preview-body",
  });
});

describe("createDecoPreviewPage", () => {
  it("is exposed by the Next.js binding", () => {
    expect((nextjs as Record<string, unknown>).createDecoPreviewPage).toBeTypeOf("function");
  });

  it("resolves and renders a section through the RSC-aware SectionRenderer", async () => {
    const setup = vi.fn(async () => {});
    const Page = createDecoPreviewPage({ setup });
    const element = await Page({
      params: Promise.resolve({ path: ["Preview Hero"] }),
      searchParams: Promise.resolve({ deviceHint: "desktop" }),
    });
    const html = renderToString(element);

    expect(setup).toHaveBeenCalledOnce();
    expect(html).toContain("hero-rsc");
    expect(html).toContain('data-manifest-key="site/sections/PreviewHero.tsx"');
    expect(html).toContain('href="/preview.css"');
    expect(html).toContain('href="/font.css"');
    expect(html).toContain('data-theme="light"');
    expect(html).toContain("preview-body");
    expect(html).toContain("editor::inject");
  });

  it("renders a visible diagnostic for an unknown section", async () => {
    const Page = createDecoPreviewPage();
    const element = await Page({
      params: Promise.resolve({ path: ["Missing"] }),
      searchParams: Promise.resolve({}),
    });

    expect(renderToString(element)).toContain("Unknown section: Missing");
  });
});
