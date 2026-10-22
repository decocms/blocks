// @vitest-environment node
/**
 * v7's draft host allowlist (`cms/draftSource.ts`: `readAllowedHosts`,
 * `isDraftHostAllowed`, `isDraftPreviewEnabled`), as `@decocms/nextjs` ports
 * it: the same cases as `@decocms/tanstack`'s worker tests.
 */
import { describe, expect, it } from "vitest";
import { POINTER, snapshot, testCMS } from "./__tests__/fixtures.ts";
import {
  allowedDraft,
  draftCookie,
  inferredPreviewHosts,
  isDraftPreviewEnabled,
  type PreviewPolicy,
  previewHostDecision,
  readDraftVersion,
  requestHost,
  requestLike,
} from "./drafts.ts";

const link = (host: string) =>
  new Request(`https://${host}/?__draft=${encodeURIComponent(POINTER)}`);

async function previews(
  policy: PreviewPolicy & { cms?: ReturnType<typeof testCMS> },
  host: string,
): Promise<boolean> {
  const { cms = testCMS(snapshot()), ...rest } = policy;
  return (await allowedDraft(cms, link(host), { site: "acme", ...rest }))?.version === POINTER;
}

describe("the draft host allowlist (v7's)", () => {
  it("with no preview hosts declared, only the site's Deco hosts preview (v7's default, not blocks' every host)", async () => {
    expect((await testCMS(snapshot()).settings()).preview.hosts).toEqual(["*"]); // blocks' own default stays
    for (const host of ["store.example.com", "www.store.example.com", "localhost:3000"]) {
      expect(await previews({}, host), host).toBe(false);
    }
    for (const host of ["acme.deco.site", "acme.deco-cx.workers.dev"]) {
      expect(await previews({}, host), host).toBe(true);
    }
    expect(await previews({ previewHosts: ["localhost:3000"] }, "localhost:3000")).toBe(true);
  });

  it('a CMS block that declares "*" previews on every host', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["store.example.com", "localhost:3000", "acme.deco.site"]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
  });

  it("the CMS block's preview hosts: only those, plus the site's Deco hosts", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com"] }));
    for (const host of [
      "staging.store.example.com",
      "acme.deco.site",
      "acme.deco-cx.workers.dev",
    ]) {
      expect(await previews({ cms }, host), host).toBe(true);
    }
    for (const host of [
      "store.example.com",
      "other.deco.site",
      "xacme.deco.site",
      "www.acme.deco.site",
      "acme.deco.site.attacker.example",
      "1a2b3c-acme.deco-cx.workers.dev",
      "acme.deco.site:8443",
      "deco.site",
    ]) {
      expect(await previews({ cms }, host), host).toBe(false);
    }
  });

  it("the Deco hosts are named after site, case-insensitively, and exactly", async () => {
    const cms = testCMS(snapshot({ previewHosts: [] }));
    expect(await previews({ cms, site: "Acme" }, "ACME.deco.site")).toBe(true);
    expect(await previews({ cms, site: "acme" }, "store.example.com")).toBe(false);
    expect(await previews({ cms, site: undefined }, "acme.deco.site")).toBe(false);
    expect(inferredPreviewHosts(" Acme ")).toEqual(["acme.deco.site", "acme.deco-cx.workers.dev"]);
    expect(inferredPreviewHosts("")).toEqual([]);
  });

  it("previewHosts replaces the CMS block's list (v7's DECO_ALLOWED_PREVIEW_HOSTS); the Deco hosts stay", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com"] }));
    const previewHosts = ["localhost:3000", "Preview.Store.Example.com"];
    expect(await previews({ cms, previewHosts }, "localhost:3000")).toBe(true);
    expect(await previews({ cms, previewHosts }, "preview.store.example.com")).toBe(true);
    expect(await previews({ cms, previewHosts }, "acme.deco.site")).toBe(true);
    expect(await previews({ cms, previewHosts }, "staging.store.example.com")).toBe(false);
    expect(await previews({ cms, previewHosts }, "localhost:3001")).toBe(false);
  });

  it("an empty previewHosts list leaves only the Deco hosts (v7's default)", async () => {
    expect(await previews({ previewHosts: [] }, "store.example.com")).toBe(false);
    expect(await previews({ previewHosts: [] }, "acme.deco.site")).toBe(true);
  });

  it('previewHosts: "none" is the kill switch: no host previews, the Deco hosts and "*" included', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["acme.deco.site", "acme.deco-cx.workers.dev", "store.example.com"]) {
      expect(await previews({ cms, previewHosts: "none" }, host), host).toBe(false);
      expect(await previews({ cms, previewHosts: ["localhost:3000", "none"] }, host), host).toBe(
        false,
      );
    }
  });

  it("only the CMS is asked when the policy can't decide", () => {
    expect(previewHostDecision("acme.deco.site", { site: "acme" })).toBe(true);
    expect(previewHostDecision("store.example.com", { site: "acme" })).toBe("cms");
    expect(previewHostDecision("store.example.com", { previewHosts: [] })).toBe(false);
    expect(previewHostDecision("", {})).toBe(false);
  });
});

describe("isDraftPreviewEnabled (v7's): whether a page may read the request at all", () => {
  it("off only for the kill switch, or with no host anywhere", async () => {
    const none = testCMS(snapshot({ previewHosts: [] }));
    const undeclared = testCMS(snapshot());
    expect(await isDraftPreviewEnabled(undeclared, {})).toBe(false); // v7: no list, no site, no previews
    expect(await isDraftPreviewEnabled(undeclared, { site: "acme" })).toBe(true);
    expect(await isDraftPreviewEnabled(testCMS(snapshot({ previewHosts: ["*"] })), {})).toBe(true);
    expect(await isDraftPreviewEnabled(testCMS(), {})).toBe(true); // declares shop.example.com
    expect(await isDraftPreviewEnabled(none, {})).toBe(false);
    expect(await isDraftPreviewEnabled(none, { site: "acme" })).toBe(true);
    expect(await isDraftPreviewEnabled(none, { previewHosts: ["localhost:3000"] })).toBe(true);
    expect(await isDraftPreviewEnabled(testCMS(), { previewHosts: [] })).toBe(false);
    expect(await isDraftPreviewEnabled(testCMS(), { site: "acme", previewHosts: "none" })).toBe(
      false,
    );
  });
});

describe("reading the request", () => {
  it("?__draft= first, then the cookie; off and garbage are no draft", () => {
    const cookie = { cookie: `a=1; __deco_draft=${encodeURIComponent(POINTER)}` };
    expect(readDraftVersion(new Request("https://s.example.com/", { headers: cookie }))).toEqual({
      version: POINTER,
    });
    expect(
      readDraftVersion(new Request("https://s.example.com/?__draft=off", { headers: cookie })),
    ).toBe(null);
    expect(
      readDraftVersion(new Request("https://s.example.com/?__draft=junk", { headers: cookie })),
    ).toEqual({ version: POINTER });
    expect(readDraftVersion(new Request("https://s.example.com/?__draft=junk"))).toBe(null);
  });

  it("the host is the visitor's: the first x-forwarded-host, else host", () => {
    expect(
      requestHost(
        new Headers({ host: "origin.internal", "x-forwarded-host": "Shop.example.com, cdn" }),
      ),
    ).toBe("Shop.example.com");
    expect(requestHost(new Headers({ host: "shop.example.com" }))).toBe("shop.example.com");
    expect(requestHost(new Headers())).toBe(null);
    expect(requestLike(new Headers({ host: "shop.example.com:3000" }), "/p?x=1")?.url).toBe(
      "https://shop.example.com:3000/p?x=1",
    );
    expect(requestLike(new Headers(), "/")).toBe(null);
  });

  it("the draft cookie is the one cms.draftCookie writes", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    const set = await cms.draftCookie(link("s.example.com"));
    expect(draftCookie(encodeURIComponent(POINTER))).toBe(set);
    const off = await cms.draftCookie(new Request("https://s.example.com/?__draft=off"));
    expect(draftCookie("", ["Max-Age=0"])).toBe(off);
  });
});
