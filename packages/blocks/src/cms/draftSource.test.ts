import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDraftCache,
  DEFAULT_PREVIEW_API_DOMAINS,
  draftPointerFromRequest,
  isDraftHostAllowed,
  isDraftPreviewEnabled,
  parseDraftPointer,
  previewApiOriginForHost,
  resolveDraftDecofile,
  resolveDraftForRequest,
  setDraftPreviewHosts,
} from "./draftSource";

const ENV_ON = { DECO_ALLOWED_PREVIEW_HOSTS: "preview.example" };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  clearDraftCache();
});

describe("parseDraftPointer", () => {
  it("parses authority@version, lowercasing the authority", () => {
    expect(parseDraftPointer("ABC.Preview-Studio.decocms.com@FF00")).toEqual({
      host: "abc.preview-studio.decocms.com",
      version: "FF00",
    });
  });

  it("keeps an explicit port on the authority", () => {
    expect(parseDraftPointer("abc.localhost:60534@v1")).toEqual({
      host: "abc.localhost:60534",
      version: "v1",
    });
  });

  it("rejects more than one @", () => {
    // A naive split("@") accepts this and silently uses the first two
    // segments — the exact hole found while spiking the fetch path.
    expect(parseDraftPointer("a.example@b@c")).toBeNull();
  });

  it("rejects anything that could escape the authority", () => {
    // No scheme, no path, no userinfo — the token carries an authority only,
    // so `javascript:`/`file:`/full URLs fail structurally at parse time.
    expect(parseDraftPointer("https://evil.example@v1")).toBeNull();
    expect(parseDraftPointer("evil.example/x@v1")).toBeNull();
    expect(parseDraftPointer("a.example:80:80@v1")).toBeNull();
    expect(parseDraftPointer("a.example:abc@v1")).toBeNull();
    expect(parseDraftPointer(".leading.dot@v1")).toBeNull();
    expect(parseDraftPointer("bare-label@v1")).toBeNull();
  });

  it("validates the version charset — it becomes a cache key", () => {
    expect(parseDraftPointer("a.example@")).toBeNull();
    expect(parseDraftPointer(`a.example@${"x".repeat(65)}`)).toBeNull();
    expect(parseDraftPointer("a.example@v 1")).toBeNull();
    expect(parseDraftPointer(null)).toBeNull();
  });
});

describe("previewApiOriginForHost", () => {
  it("admits authorities under the default deco domains", () => {
    expect(previewApiOriginForHost("abc.preview-studio.decocms.com", {})).toBe(
      "https://abc.preview-studio.decocms.com",
    );
    expect(previewApiOriginForHost("abc.local.studio.decocms.com", {})).toBe(
      "https://abc.local.studio.decocms.com",
    );
    expect(previewApiOriginForHost("abc.localhost:60534", {})).toBe("http://abc.localhost:60534");
  });

  it("rejects hosts outside the domains — the token proposes, config disposes", () => {
    expect(previewApiOriginForHost("evil.example", {})).toBeNull();
    // Dot-prefixed suffixes guarantee a label boundary: a lookalike domain
    // that merely ends with the same characters cannot pass.
    expect(previewApiOriginForHost("evil-preview-studio.decocms.com", {})).toBeNull();
    // The domain itself (no label in front) is not a draft host.
    expect(previewApiOriginForHost("preview-studio.decocms.com", {})).toBeNull();
  });

  it("allows an explicit port only under localhost-ish domains", () => {
    // A public-domain token must not steer the fetch at odd ports.
    expect(previewApiOriginForHost("abc.preview-studio.decocms.com:8500", {})).toBeNull();
  });

  it("honours a configured override instead of the defaults", () => {
    const env = { DECO_PREVIEW_API_DOMAINS: ".staging.example" };
    expect(previewApiOriginForHost("abc.staging.example", env)).toBe("https://abc.staging.example");
    expect(previewApiOriginForHost("abc.preview-studio.decocms.com", env)).toBeNull();
  });
});

describe("gating", () => {
  it("is on iff an allowed host is configured — API domains have defaults", () => {
    expect(isDraftPreviewEnabled(ENV_ON)).toBe(true);
    expect(isDraftPreviewEnabled({})).toBe(false);
  });

  it("matches request hosts verbatim, port included, case-insensitively", () => {
    const env = { DECO_ALLOWED_PREVIEW_HOSTS: "fila.vtex.app, localhost:3100" };
    expect(isDraftHostAllowed("FILA.VTEX.APP", env)).toBe(true);
    expect(isDraftHostAllowed("localhost:3100", env)).toBe(true);
    expect(isDraftHostAllowed("fila.com.br", env)).toBe(false);
    expect(isDraftHostAllowed("localhost", env)).toBe(false);
    expect(isDraftHostAllowed(null, env)).toBe(false);
    expect(isDraftHostAllowed("fila.vtex.app", {})).toBe(false);
  });
});

describe("resolveDraftDecofile", () => {
  it("fetches exactly the token's validated origin", async () => {
    const calls: string[] = [];
    const blocks = await resolveDraftDecofile({
      pointer: "abc.preview-studio.decocms.com@v1",
      env: ENV_ON,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return jsonResponse({ "pages-home": { title: "draft" } });
      }) as unknown as typeof fetch,
    });

    expect(blocks).toEqual({ "pages-home": { title: "draft" } });
    expect(calls).toEqual(["https://abc.preview-studio.decocms.com/_sandbox/decofile"]);
  });

  it("is inert without a host allowlist — no fetch at all", async () => {
    let called = false;
    const blocks = await resolveDraftDecofile({
      pointer: "abc.preview-studio.decocms.com@v1",
      env: {},
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
    expect(called).toBe(false);
  });

  it("refuses a parseable token whose origin no domain admits — no fetch", async () => {
    let called = false;
    const blocks = await resolveDraftDecofile({
      pointer: "abc.evil.example@v1",
      env: ENV_ON,
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
    expect(called).toBe(false);
  });

  it("caches by version — one fetch per version, not per request", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return jsonResponse({ n: fetches });
    }) as unknown as typeof fetch;
    const P = "abc.preview-studio.decocms.com";

    const a = await resolveDraftDecofile({ pointer: `${P}@v1`, env: ENV_ON, fetchImpl });
    const b = await resolveDraftDecofile({ pointer: `${P}@v1`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(1);
    expect(b).toBe(a);

    await resolveDraftDecofile({ pointer: `${P}@v2`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(2);
  });

  it("bounds the cache so multi-MB decofiles can't accumulate", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return jsonResponse({ n: fetches });
    }) as unknown as typeof fetch;
    const P = "abc.preview-studio.decocms.com";

    for (const v of ["v1", "v2", "v3", "v4"]) {
      await resolveDraftDecofile({ pointer: `${P}@${v}`, env: ENV_ON, fetchImpl });
    }
    expect(fetches).toBe(4);
    await resolveDraftDecofile({ pointer: `${P}@v1`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5); // v1 evicted (cap 3) — re-fetch, never stale
    await resolveDraftDecofile({ pointer: `${P}@v4`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5); // v4 resident
  });

  it("degrades to published on unreachable / non-2xx / unparseable", async () => {
    const P = "abc.preview-studio.decocms.com";
    for (const fetchImpl of [
      async () => {
        throw new Error("ECONNREFUSED");
      },
      async () => new Response("nope", { status: 404 }),
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ]) {
      clearDraftCache();
      expect(
        await resolveDraftDecofile({
          pointer: `${P}@v1`,
          env: ENV_ON,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).toBeNull();
    }
  });
});

// DEFAULT_PREVIEW_API_DOMAINS is part of the public contract — pin it.
describe("DEFAULT_PREVIEW_API_DOMAINS", () => {
  it("ships the deco-operated origins, dot-prefixed", () => {
    expect(DEFAULT_PREVIEW_API_DOMAINS).toEqual([
      ".preview-studio.decocms.com",
      ".local.studio.decocms.com",
      ".localhost",
    ]);
  });
});

describe("site-block preview hosts", () => {
  it("enables the feature from the site block alone — no env needed", () => {
    setDraftPreviewHosts(["fila.vtex.app", "LOCALHOST:3100", 42, "  "]);
    try {
      expect(isDraftPreviewEnabled({})).toBe(true);
      expect(isDraftHostAllowed("fila.vtex.app", {})).toBe(true);
      // Sanitized: lowercased, non-strings and blanks dropped.
      expect(isDraftHostAllowed("localhost:3100", {})).toBe(true);
      expect(isDraftHostAllowed("evil.example", {})).toBe(false);
    } finally {
      setDraftPreviewHosts([]);
    }
  });

  it("env REPLACES the block hosts when set — the operational escape hatch", () => {
    setDraftPreviewHosts(["fila.vtex.app"]);
    try {
      const env = { DECO_ALLOWED_PREVIEW_HOSTS: "other.example" };
      expect(isDraftHostAllowed("other.example", env)).toBe(true);
      // Not merged: env is a kill switch / override, so the block value must
      // not survive alongside it.
      expect(isDraftHostAllowed("fila.vtex.app", env)).toBe(false);
    } finally {
      setDraftPreviewHosts([]);
    }
  });
});

describe("draftPointerFromRequest", () => {
  it("reads the pointer from the __deco_draft cookie (in-preview navigation)", () => {
    const req = new Request("https://preview.example/deco/invoke/site/loaders/x.ts", {
      headers: { cookie: "a=1; __deco_draft=abc.preview-studio.decocms.com@v1; b=2" },
    });
    expect(draftPointerFromRequest(req)).toBe("abc.preview-studio.decocms.com@v1");
  });

  it("lets ?__draft= win over the cookie", () => {
    const req = new Request("https://preview.example/p?__draft=h@v2", {
      headers: { cookie: "__deco_draft=h@v1" },
    });
    expect(draftPointerFromRequest(req)).toBe("h@v2");
  });

  it("returns null on ?__draft=off even with a cookie set", () => {
    const req = new Request("https://preview.example/p?__draft=off", {
      headers: { cookie: "__deco_draft=h@v1" },
    });
    expect(draftPointerFromRequest(req)).toBeNull();
  });

  it("returns null with neither param nor cookie", () => {
    expect(draftPointerFromRequest(new Request("https://preview.example/p"))).toBeNull();
  });
});

describe("resolveDraftForRequest", () => {
  const ENV = { DECO_ALLOWED_PREVIEW_HOSTS: "preview.example" };
  function invokeReq(host = "preview.example"): Request {
    return new Request("https://preview.example/deco/invoke/site/loaders/x.ts", {
      method: "POST",
      headers: {
        "x-forwarded-host": host,
        cookie: "__deco_draft=abc.preview-studio.decocms.com@v1",
      },
    });
  }

  it("binds the draft when host is allowed and the pointer resolves", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ "site/x": { value: "draft" } })) as unknown as typeof fetch;
    expect(await resolveDraftForRequest(invokeReq(), { env: ENV, fetchImpl })).toEqual({
      "site/x": { value: "draft" },
    });
  });

  it("is inert with no allowlist — never touches the network", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(await resolveDraftForRequest(invokeReq(), { env: {}, fetchImpl })).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the request host is not on the allowlist (prod stays published)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(
      await resolveDraftForRequest(invokeReq("prod.example"), { env: ENV, fetchImpl }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the request carries no draft pointer", async () => {
    const req = new Request("https://preview.example/deco/invoke/site/loaders/x.ts", {
      headers: { "x-forwarded-host": "preview.example" },
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(await resolveDraftForRequest(req, { env: ENV, fetchImpl })).toBeNull();
    expect(called).toBe(false);
  });
});
