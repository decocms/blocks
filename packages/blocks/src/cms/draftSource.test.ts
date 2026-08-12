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
  it("parses <authority><path>@<version>, lowercasing the authority", () => {
    expect(
      parseDraftPointer(
        "Studio.decocms.com/api/fila/decofile/vm-1/main?token=Tok.abc@8c1d44e",
      ),
    ).toEqual({
      host: "studio.decocms.com",
      path: "/api/fila/decofile/vm-1/main?token=Tok.abc",
      version: "8c1d44e",
    });
  });

  it("keeps an explicit port on the authority, incl. bare localhost", () => {
    expect(parseDraftPointer("localhost:4000/api/o/decofile/m/b@v1")).toEqual({
      host: "localhost:4000",
      path: "/api/o/decofile/m/b",
      version: "v1",
    });
  });

  it("splits on the LAST @ — an earlier @ fails validation, never half-reads", () => {
    // The path charset excludes `@`, so a smuggled one lands in `path` and
    // fails PATH_RE rather than shifting the version boundary.
    expect(parseDraftPointer("a.example/x@y/z@v1")).toBeNull();
    expect(parseDraftPointer("a@b@c")).toBeNull();
  });

  it("requires a rooted path — authority-only tokens are gone", () => {
    // Non-backcompat: the daemon-era `<authority>@<version>` form is invalid.
    expect(parseDraftPointer("abc.preview-studio.decocms.com@v1")).toBeNull();
    expect(parseDraftPointer("a.example@v1")).toBeNull();
  });

  it("rejects anything that could escape the authority or path", () => {
    // No scheme, no userinfo, no fragment/space in the path — a full URL
    // fails structurally at parse time.
    expect(parseDraftPointer("https://evil.example/x@v1")).toBeNull();
    expect(parseDraftPointer("a.example:80:80/x@v1")).toBeNull();
    expect(parseDraftPointer("a.example:abc/x@v1")).toBeNull();
    expect(parseDraftPointer(".leading.dot/x@v1")).toBeNull();
    expect(parseDraftPointer("a.example/x#frag@v1")).toBeNull();
    expect(parseDraftPointer("a.example/x y@v1")).toBeNull();
  });

  it("validates the version charset — it becomes a cache key", () => {
    expect(parseDraftPointer("a.example/x@")).toBeNull();
    expect(parseDraftPointer(`a.example/x@${"x".repeat(65)}`)).toBeNull();
    expect(parseDraftPointer("a.example/x@v 1")).toBeNull();
    expect(parseDraftPointer(null)).toBeNull();
  });
});

describe("previewApiOriginForHost", () => {
  it("admits authorities under the default deco domains", () => {
    // Hosted Studio (the decofile API origin) via the .decocms.com suffix.
    expect(previewApiOriginForHost("studio.decocms.com", {})).toBe(
      "https://studio.decocms.com",
    );
    // Preview daemons keep working under the same suffix.
    expect(previewApiOriginForHost("abc.preview-studio.decocms.com", {})).toBe(
      "https://abc.preview-studio.decocms.com",
    );
    // Local dev: exact-host entries, http, explicit port allowed.
    expect(previewApiOriginForHost("localhost:4000", {})).toBe(
      "http://localhost:4000",
    );
    // The native app's dev origin serves TLS (locally-trusted cert): https,
    // but the explicit port is still allowed.
    expect(previewApiOriginForHost("local.studio.decocms.com:4420", {})).toBe(
      "https://local.studio.decocms.com:4420",
    );
    expect(previewApiOriginForHost("abc.localhost:60534", {})).toBe(
      "http://abc.localhost:60534",
    );
  });

  it("rejects hosts outside the domains — the token proposes, config disposes", () => {
    expect(previewApiOriginForHost("evil.example", {})).toBeNull();
    // Dot-prefixed suffixes guarantee a label boundary: a lookalike domain
    // that merely ends with the same characters cannot pass.
    expect(previewApiOriginForHost("evil-decocms.com", {})).toBeNull();
    // The suffix domain itself (no label in front) is not admitted.
    expect(previewApiOriginForHost("decocms.com", {})).toBeNull();
  });

  it("allows an explicit port only for local entries", () => {
    // A public-domain token must not steer the fetch at odd ports.
    expect(previewApiOriginForHost("studio.decocms.com:8500", {})).toBeNull();
    expect(
      previewApiOriginForHost("abc.preview-studio.decocms.com:8500", {}),
    ).toBeNull();
  });

  it("honours a configured override instead of the defaults", () => {
    const env = { DECO_PREVIEW_API_DOMAINS: ".staging.example" };
    expect(previewApiOriginForHost("abc.staging.example", env)).toBe(
      "https://abc.staging.example",
    );
    expect(previewApiOriginForHost("studio.decocms.com", env)).toBeNull();
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

// Canonical Studio decofile-API pointer prefix (authority + path, no version).
const P = "studio.decocms.com/api/fila/decofile/vm-1/main?token=tok.abc";

describe("resolveDraftDecofile", () => {
  it("fetches the token's path on its validated origin", async () => {
    const calls: string[] = [];
    const blocks = await resolveDraftDecofile({
      pointer: `${P}@v1`,
      env: ENV_ON,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return jsonResponse({ "pages-home": { title: "draft" } });
      }) as unknown as typeof fetch,
    });

    expect(blocks).toEqual({ "pages-home": { title: "draft" } });
    expect(calls).toEqual([
      "https://studio.decocms.com/api/fila/decofile/vm-1/main?token=tok.abc",
    ]);
  });

  it("is inert without a host allowlist — no fetch at all", async () => {
    let called = false;
    const blocks = await resolveDraftDecofile({
      pointer: `${P}@v1`,
      env: {},
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
    expect(called).toBe(false);
  });

  it("refuses a parseable token whose origin no domain admits — no fetch, no cache", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(
      await resolveDraftDecofile({
        pointer: "abc.evil.example/x@v1",
        env: ENV_ON,
        fetchImpl,
      }),
    ).toBeNull();
    expect(called).toBe(false);

    // Origin validation runs BEFORE the cache: a version already cached from
    // an allowed origin must not be served for a disallowed authority.
    await resolveDraftDecofile({ pointer: `${P}@vX`, env: ENV_ON, fetchImpl });
    expect(called).toBe(true);
    expect(
      await resolveDraftDecofile({
        pointer: "abc.evil.example/x@vX",
        env: ENV_ON,
        fetchImpl,
      }),
    ).toBeNull();
  });

  it("caches by version — one fetch per version, not per request", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return jsonResponse({ n: fetches });
    }) as unknown as typeof fetch;

    const a = await resolveDraftDecofile({
      pointer: `${P}@v1`,
      env: ENV_ON,
      fetchImpl,
    });
    const b = await resolveDraftDecofile({
      pointer: `${P}@v1`,
      env: ENV_ON,
      fetchImpl,
    });
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

    for (const v of ["v1", "v2", "v3", "v4"]) {
      await resolveDraftDecofile({
        pointer: `${P}@${v}`,
        env: ENV_ON,
        fetchImpl,
      });
    }
    expect(fetches).toBe(4);
    await resolveDraftDecofile({ pointer: `${P}@v1`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5); // v1 evicted (cap 3) — re-fetch, never stale
    await resolveDraftDecofile({ pointer: `${P}@v4`, env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5); // v4 resident
  });

  it("degrades to published on unreachable / non-2xx / unparseable", async () => {
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
  it("ships the deco-operated origins plus local-dev exact hosts", () => {
    expect(DEFAULT_PREVIEW_API_DOMAINS).toEqual([
      "local.studio.decocms.com",
      "localhost",
      "127.0.0.1",
      ".localhost",
      ".decocms.com",
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
    const req = new Request(
      "https://preview.example/deco/invoke/site/loaders/x.ts",
      {
        headers: {
          cookie: "a=1; __deco_draft=abc.preview-studio.decocms.com@v1; b=2",
        },
      },
    );
    expect(draftPointerFromRequest(req)).toBe(
      "abc.preview-studio.decocms.com@v1",
    );
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
    expect(
      draftPointerFromRequest(new Request("https://preview.example/p")),
    ).toBeNull();
  });
});

describe("resolveDraftForRequest", () => {
  const ENV = { DECO_ALLOWED_PREVIEW_HOSTS: "preview.example" };
  function invokeReq(host = "preview.example"): Request {
    return new Request(
      "https://preview.example/deco/invoke/site/loaders/x.ts",
      {
        method: "POST",
        headers: {
          "x-forwarded-host": host,
          cookie: `__deco_draft=${encodeURIComponent(`${P}@v1`)}`,
        },
      },
    );
  }

  it("binds the draft when host is allowed and the pointer resolves", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        "site/x": { value: "draft" },
      })) as unknown as typeof fetch;
    expect(
      await resolveDraftForRequest(invokeReq(), { env: ENV, fetchImpl }),
    ).toEqual({
      "site/x": { value: "draft" },
    });
  });

  it("is inert with no allowlist — never touches the network", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(
      await resolveDraftForRequest(invokeReq(), { env: {}, fetchImpl }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the request host is not on the allowlist (prod stays published)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(
      await resolveDraftForRequest(invokeReq("prod.example"), {
        env: ENV,
        fetchImpl,
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the request carries no draft pointer", async () => {
    const req = new Request(
      "https://preview.example/deco/invoke/site/loaders/x.ts",
      {
        headers: { "x-forwarded-host": "preview.example" },
      },
    );
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(
      await resolveDraftForRequest(req, { env: ENV, fetchImpl }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});
