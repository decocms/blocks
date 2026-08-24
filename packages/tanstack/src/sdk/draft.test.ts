import {
  clearDraftCache,
  getRequestDraftOverride,
  isDraftPreviewEnabled,
  setDecoSiteHost,
  setDraftPreviewHosts,
} from "@decocms/blocks/cms";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDraftCookieAndHeaders,
  bindRequestDraft,
  type DraftDecision,
  installDecoSiteHostFromEnv,
  installPreviewHostsFromBlocks,
  registerDraftOverride,
  requestCarriesDraft,
} from "./draft";
import { DRAFT_POINTER_BAG_KEY } from "./draftShared";

const HOST = "preview.example";
const DRAFT_BLOCKS = { "pages-home": { title: "draft" } };

function req(
  opts: { url?: string; host?: string; cookie?: string } = {},
): Request {
  const headers = new Headers();
  headers.set("host", opts.host ?? HOST);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new Request(opts.url ?? `https://${opts.host ?? HOST}/some/page`, {
    headers,
  });
}

/** A fetch stub serving the sandbox decofile; throws if `fail`. */
function sandboxFetch(fail = false): typeof fetch {
  return (async () => {
    if (fail) throw new Error("unreachable");
    return new Response(JSON.stringify(DRAFT_BLOCKS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearDraftCache();
  // Allowlist is globalThis-backed (the site block's previewHosts), so no env
  // needed — this makes the feature "enabled" for the tests below.
  setDraftPreviewHosts([HOST, "localhost:3100"]);
});

afterEach(() => {
  setDraftPreviewHosts([]);
});

describe("requestCarriesDraft", () => {
  it("is inert when no allowlist is configured", () => {
    setDraftPreviewHosts([]);
    const url = new URL(
      `https://${HOST}/p?__draft=abc.preview-studio.decocms.com@v1`,
    );
    expect(requestCarriesDraft(req({ url: url.toString() }), url)).toBe(false);
  });

  it("detects the ?__draft= entry param", () => {
    const url = new URL(
      `https://${HOST}/p?__draft=abc.preview-studio.decocms.com@v1`,
    );
    expect(requestCarriesDraft(req({ url: url.toString() }), url)).toBe(true);
  });

  it("detects the navigation cookie (SPA nav after entry)", () => {
    const url = new URL(`https://${HOST}/p`);
    expect(
      requestCarriesDraft(
        req({ url: url.toString(), cookie: "__deco_draft=abc.x@v1" }),
        url,
      ),
    ).toBe(true);
  });

  it("is false on ?__draft=off (leaving preview)", () => {
    const url = new URL(`https://${HOST}/p?__draft=off`);
    expect(
      requestCarriesDraft(
        req({ url: url.toString(), cookie: "__deco_draft=abc.x@v1" }),
        url,
      ),
    ).toBe(false);
  });

  it("is structurally inert on a non-preview host, param or not", () => {
    const url = new URL("https://prod.example/p?__draft=abc.x@v1");
    expect(
      requestCarriesDraft(
        req({ url: url.toString(), host: "prod.example" }),
        url,
      ),
    ).toBe(false);
  });
});

describe("bindRequestDraft", () => {
  it("binds the resolved draft to the request bag on entry", async () => {
    registerDraftOverride();
    const pointer = "studio.decocms.com/api/o/decofile/m/main?token=t@v1";
    const request = req({ url: `https://${HOST}/p?__draft=${pointer}` });

    const decision = await RequestContext.run(request, async () => {
      const d = await bindRequestDraft(request, sandboxFetch());
      // loadBlocks() reads this back via the DI getter registered above.
      expect(getRequestDraftOverride()).toEqual(DRAFT_BLOCKS);
      return d;
    });

    expect(decision).toEqual({
      previewing: true,
      setCookie: pointer,
      clearCookie: false,
    });
  });

  it("carries the draft across navigation via the cookie (no re-set)", async () => {
    registerDraftOverride();
    const pointer = "abc.preview-studio.decocms.com@v1";
    const request = req({
      url: `https://${HOST}/other`,
      cookie: `__deco_draft=${pointer}`,
    });

    const decision = await RequestContext.run(request, () =>
      bindRequestDraft(request, sandboxFetch()),
    );

    // previewing, but setCookie is null — the cookie is already present.
    expect(decision).toEqual({
      previewing: true,
      setCookie: null,
      clearCookie: false,
    });
  });

  it("decodes a URL-encoded cookie so the badge pointer round-trips (no double-encode)", async () => {
    // The cookie is written with encodeURIComponent (`:`→%3A, `@`→%40); the
    // pointer stashed for the badge must be the DECODED value, or the badge's
    // share link would re-encode an already-encoded string.
    registerDraftOverride();
    const decoded = "abc.localhost:60534/api/o/decofile/m/main?token=t@v7";
    const request = req({
      url: `https://${HOST}/other`,
      cookie: `__deco_draft=${encodeURIComponent(decoded)}`,
    });

    const stored = await RequestContext.run(request, async () => {
      await bindRequestDraft(request, sandboxFetch());
      return RequestContext.getBag<string>(DRAFT_POINTER_BAG_KEY);
    });

    expect(stored).toBe(decoded);
  });

  it("stays previewing (uncacheable) even when the draft fails to resolve", async () => {
    const request = req({
      url: `https://${HOST}/p?__draft=abc.preview-studio.decocms.com@v1`,
    });
    const decision = await RequestContext.run(request, () =>
      bindRequestDraft(request, sandboxFetch(true)),
    );
    expect(decision.previewing).toBe(true);
    expect(decision.setCookie).toBe("abc.preview-studio.decocms.com@v1");
  });

  it("clears the cookie on ?__draft=off", async () => {
    const request = req({
      url: `https://${HOST}/p?__draft=off`,
      cookie: "__deco_draft=x@v1",
    });
    const decision = await RequestContext.run(request, () =>
      bindRequestDraft(request),
    );
    expect(decision).toEqual({
      previewing: false,
      setCookie: null,
      clearCookie: true,
    });
  });

  it("is inert on a non-preview host", async () => {
    const request = req({
      url: "https://prod.example/p?__draft=abc.x@v1",
      host: "prod.example",
    });
    const decision = await RequestContext.run(request, () =>
      bindRequestDraft(request),
    );
    expect(decision).toEqual({
      previewing: false,
      setCookie: null,
      clearCookie: false,
    });
  });
});

describe("applyDraftCookieAndHeaders", () => {
  const entry: DraftDecision = {
    previewing: true,
    setCookie: "abc@v1",
    clearCookie: false,
  };

  it("sets a cross-site-iframe-safe cookie and the anti-leak headers on entry", () => {
    const res = new Response("ok");
    applyDraftCookieAndHeaders(res, entry);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__deco_draft=abc%40v1"); // pointer is URL-encoded
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain("HttpOnly");

    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("expires the cookie when leaving preview", () => {
    const res = new Response("ok");
    applyDraftCookieAndHeaders(res, {
      previewing: false,
      setCookie: null,
      clearCookie: true,
    });
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    // Not previewing → no cache/index headers.
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("merges Cookie into an existing Vary instead of clobbering it", () => {
    const res = new Response("ok", { headers: { Vary: "Accept-Encoding" } });
    applyDraftCookieAndHeaders(res, {
      previewing: true,
      setCookie: null,
      clearCookie: false,
    });
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it("leaves a Vary that already lists Cookie untouched (no token dropped)", () => {
    const res = new Response("ok", {
      headers: { Vary: "Accept-Encoding, Cookie" },
    });
    applyDraftCookieAndHeaders(res, {
      previewing: true,
      setCookie: null,
      clearCookie: false,
    });
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Cookie");
  });

  it("does nothing for an ordinary (non-draft) response", () => {
    const res = new Response("ok");
    applyDraftCookieAndHeaders(res, {
      previewing: false,
      setCookie: null,
      clearCookie: false,
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("installPreviewHostsFromBlocks", () => {
  it("installs previewHosts from the site block (either casing)", async () => {
    setDraftPreviewHosts([]);
    installPreviewHostsFromBlocks({
      Site: { previewHosts: ["fila.vtex.app"] },
    });

    // Verified through the wire: an allowed host now previews.
    const request = req({
      url: "https://fila.vtex.app/p?__draft=abc.preview-studio.decocms.com@v1",
      host: "fila.vtex.app",
    });
    const url = new URL(request.url);
    expect(requestCarriesDraft(request, url)).toBe(true);
  });

  it("ignores blocks without previewHosts", () => {
    setDraftPreviewHosts([]);
    installPreviewHostsFromBlocks({ site: {} });
    const url = new URL("https://fila.vtex.app/p?__draft=x@v1");
    expect(
      requestCarriesDraft(
        req({ url: url.toString(), host: "fila.vtex.app" }),
        url,
      ),
    ).toBe(false);
  });
});

describe("installDecoSiteHostFromEnv", () => {
  afterEach(() => {
    setDecoSiteHost(null);
  });

  it("arms the deco-hosted domains from the DECO_SITE_NAME binding", () => {
    setDraftPreviewHosts([]);
    installDecoSiteHostFromEnv({ DECO_SITE_NAME: "casaevideo-tanstack" });

    // Verified through the wire: both deco-operated hosts now preview, with no
    // site-block/env config at all.
    for (const host of [
      "casaevideo-tanstack.deco.site",
      "casaevideo-tanstack.deco-cx.workers.dev",
    ]) {
      const url = new URL(
        `https://${host}/p?__draft=abc.preview-studio.decocms.com@v1`,
      );
      expect(requestCarriesDraft(req({ url: url.toString(), host }), url)).toBe(true);
    }
    // A custom production domain is never inferred.
    const url = new URL("https://www.casaevideo.com.br/p?__draft=x@v1");
    expect(
      requestCarriesDraft(
        req({ url: url.toString(), host: "www.casaevideo.com.br" }),
        url,
      ),
    ).toBe(false);
  });

  it("an unset or non-string binding registers nothing", () => {
    setDraftPreviewHosts([]);
    installDecoSiteHostFromEnv({});
    expect(isDraftPreviewEnabled({})).toBe(false);
    installDecoSiteHostFromEnv({ DECO_SITE_NAME: 42 });
    expect(isDraftPreviewEnabled({})).toBe(false);
  });
});
