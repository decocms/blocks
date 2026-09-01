// @vitest-environment node

import { registerSection, setBlocks, WELL_KNOWN_TYPES } from "@decocms/blocks/cms";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import * as admin from "./index";
import { handleRender } from "./render";
import { resolvePreviewRequest } from "./resolvePreview";

const HERO = "site/sections/Hero.tsx";

beforeEach(() => {
  setBlocks({});
  registerSection(HERO, async () => ({
    default: ({ label }: { label?: string }) => createElement("h1", null, `hero-${label}`),
  }));
});

describe("resolvePreviewRequest", () => {
  it("is exposed by the blocks-admin protocol package", () => {
    expect((admin as Record<string, unknown>).resolvePreviewRequest).toBeTypeOf("function");
  });

  it("resolves a direct section and query-string props", async () => {
    const props = encodeURIComponent(JSON.stringify({ label: "query" }));
    const result = await resolvePreviewRequest(
      new Request(`http://localhost/live/previews/${encodeURIComponent(HERO)}?props=${props}`),
    );

    expect(result).toEqual({
      type: "sections",
      previewType: "section",
      component: HERO,
      sections: [{ component: HERO, key: HERO, props: { label: "query" } }],
    });
  });

  it("resolves a direct section and props from a POST body", async () => {
    const result = await resolvePreviewRequest(
      new Request("http://localhost/live/previews/ignored", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ __resolveType: HERO, label: "post" }),
      }),
    );

    expect(result).toMatchObject({
      type: "sections",
      previewType: "section",
      component: HERO,
      sections: [{ component: HERO, props: { label: "post" } }],
    });
  });

  it("resolves a double-encoded named block", async () => {
    setBlocks({
      "Hero Block": { __resolveType: HERO, label: "named" },
    });

    const result = await resolvePreviewRequest(
      new Request("http://localhost/live/previews/Hero%2520Block"),
    );

    expect(result).toMatchObject({
      type: "sections",
      component: HERO,
      sections: [{ component: HERO, props: { label: "named" } }],
    });
  });

  it("resolves and enriches every section in a page preview", async () => {
    const props = encodeURIComponent(
      JSON.stringify({
        sections: [{ __resolveType: HERO, label: "page" }],
      }),
    );
    const result = await resolvePreviewRequest(
      new Request(
        `http://localhost/live/previews/page?resolveChain=${encodeURIComponent(WELL_KNOWN_TYPES.PAGE)}&props=${props}`,
      ),
    );

    expect(result).toMatchObject({
      type: "sections",
      component: WELL_KNOWN_TYPES.PAGE,
      sections: [{ component: HERO, props: { label: "page" } }],
    });
  });

  it("applies POST decofile overrides only for the current preview", async () => {
    setBlocks({
      "Hero Block": { __resolveType: HERO, label: "base" },
    });
    const request = new Request("http://localhost/live/previews/Hero%2520Block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        __decofile: {
          "Hero Block": { __resolveType: HERO, label: "override" },
        },
      }),
    });

    const result = await resolvePreviewRequest(request);

    expect(result).toMatchObject({
      type: "sections",
      component: HERO,
      sections: [{ component: HERO, props: { label: "override" } }],
    });
    expect(
      await resolvePreviewRequest(new Request("http://localhost/live/previews/Hero%2520Block")),
    ).toMatchObject({ sections: [{ props: { label: "base" } }] });
  });

  it("keeps handleRender's complete HTML response contract", async () => {
    const props = encodeURIComponent(JSON.stringify({ label: "html" }));
    const response = await handleRender(
      new Request(`http://localhost/live/previews/${encodeURIComponent(HERO)}?props=${props}`),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("hero-html");
    expect(html).toContain("editor::inject");
  });

  it("wraps each rendered section in <section data-manifest-key> so the in-place preview replace can map it", async () => {
    setBlocks({
      "/pages/home": {
        __resolveType: WELL_KNOWN_TYPES.PAGE,
        sections: [
          { __resolveType: HERO, label: "a" },
          { __resolveType: HERO, label: "b" },
        ],
      },
    });

    const response = await handleRender(
      new Request(`http://localhost/live/previews/${encodeURIComponent("/pages/home")}`),
    );
    const html = await response.text();

    // Same wrapper markup as production (DecoPageRenderer.tsx): id derived from
    // the section key, data-manifest-key set to the raw key.
    expect(html).toContain(`<section id="Hero" data-manifest-key="${HERO}">`);
    // Both sections are individually wrapped — not concatenated into one blob.
    expect(html.match(/data-manifest-key/g)?.length).toBe(2);
    expect(html).toContain("hero-a");
    expect(html).toContain("hero-b");
  });
});
