// @vitest-environment node
/**
 * The draft host check, as `@decocms/nextjs` asks the CMS: the hosts Studio
 * writes into the current release's metadata (`cms.readVersion`); the same
 * cases as `@decocms/tanstack`'s worker tests.
 */
import { describe, expect, it } from "vitest";
import { POINTER, snapshot, testCMS } from "./__tests__/fixtures.ts";
import { allowedDraft, draftCookie, readDraftVersion, requestHost, requestLike } from "./drafts.ts";

const link = (host: string) =>
  new Request(`https://${host}/?__draft=${encodeURIComponent(POINTER)}`);

async function previews(cms: ReturnType<typeof testCMS>, host: string): Promise<boolean> {
  return (await allowedDraft(cms, link(host)))?.version === POINTER;
}

describe("the draft hosts: the release's, as the CMS reads them", () => {
  it("with no list in the release (no site published one), every host previews; an empty list, none", async () => {
    const open = testCMS(snapshot());
    expect((await open.settings()).preview.hosts).toEqual(["*"]);
    for (const host of ["shop.example.com", "localhost:3000", "acme.deco.site"]) {
      expect(await previews(open, host), host).toBe(true);
    }
    const closed = testCMS(snapshot({ previewHosts: [] }));
    expect((await closed.settings()).preview.hosts).toEqual([]);
    for (const host of ["shop.example.com", "localhost:3000", "acme.deco.site"]) {
      expect(await previews(closed, host), host).toBe(false);
    }
  });

  it('a release whose hosts are "*" previews on every host', async () => {
    const cms = testCMS(snapshot({ previewHosts: ["*"] }));
    for (const host of ["store.example.com", "localhost:3000", "acme.deco.site"]) {
      expect(await previews(cms, host), host).toBe(true);
    }
  });

  it("the release's preview hosts: only those, wildcards as the CMS matches them", async () => {
    const cms = testCMS(snapshot({ previewHosts: ["staging.store.example.com", "*.deco.site"] }));
    for (const host of ["staging.store.example.com", "acme.deco.site", "acme.deco.site:8443"]) {
      expect(await previews(cms, host), host).toBe(true);
    }
    for (const host of [
      "store.example.com",
      "deco.site",
      "acme.deco.site.attacker.example",
      "acme.deco-cx.workers.dev",
    ]) {
      expect(await previews(cms, host), host).toBe(false);
    }
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
