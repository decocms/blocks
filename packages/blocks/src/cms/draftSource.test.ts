import { beforeEach, describe, expect, it } from "vitest";

import {
  buildDraftOrigin,
  clearDraftCache,
  DEFAULT_SANDBOX_ORIGIN_SUFFIXES,
  isDraftHostAllowed,
  isDraftPreviewEnabled,
  parseDraftPointer,
  resolveDraftDecofile,
} from "./draftSource";

const ENV_ON = {
  DECO_DRAFT_PREVIEW_HOST: "preview.example",
  DECO_SANDBOX_ORIGIN_SUFFIXES: ".preview-studio.decocms.com",
};

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
  it("parses handle@version", () => {
    expect(parseDraftPointer("gimenes-abc123@ff00")).toEqual({
      handle: "gimenes-abc123",
      version: "ff00",
    });
  });

  it("rejects more than one @", () => {
    // A naive split("@") accepts this and silently uses the first two
    // segments — the exact hole found while spiking the fetch path.
    expect(parseDraftPointer("a@b@c")).toBeNull();
  });

  it("rejects a handle that could escape the authority", () => {
    expect(parseDraftPointer("evil.com/x@v1")).toBeNull();
    expect(parseDraftPointer("user:pw@v1")).toBeNull();
    expect(parseDraftPointer("a/../b@v1")).toBeNull();
    expect(parseDraftPointer(".leading-dot@v1")).toBeNull();
  });

  it("rejects empty halves and missing input", () => {
    expect(parseDraftPointer("@v1")).toBeNull();
    expect(parseDraftPointer("handle@")).toBeNull();
    expect(parseDraftPointer("handle")).toBeNull();
    expect(parseDraftPointer(null)).toBeNull();
    expect(parseDraftPointer("")).toBeNull();
  });
});

describe("buildDraftOrigin", () => {
  it("builds https from the configured suffix", () => {
    expect(buildDraftOrigin("abc", ".preview-studio.decocms.com")).toBe(
      "https://abc.preview-studio.decocms.com",
    );
  });

  it("uses http for a localhost suffix (local e2e)", () => {
    expect(buildDraftOrigin("abc", ".localhost:3200")).toBe("http://abc.localhost:3200");
  });

  it("returns null with no configured suffix — never guesses an origin", () => {
    expect(buildDraftOrigin("abc", "")).toBeNull();
  });
});

describe("isDraftPreviewEnabled", () => {
  it("is on iff an allowed host is configured — suffixes have defaults", () => {
    // Inverted from the old two-key gate: suffixes now default to the
    // deco-operated origins, so the single opt-in is the host allowlist.
    // Upgrading the package with no host configured stays fully inert.
    expect(isDraftPreviewEnabled(ENV_ON)).toBe(true);
    expect(isDraftPreviewEnabled({ DECO_DRAFT_PREVIEW_HOST: "a.example" })).toBe(true);
    expect(
      isDraftPreviewEnabled({
        DECO_SANDBOX_ORIGIN_SUFFIXES: ".preview-studio.decocms.com",
      }),
    ).toBe(false);
    expect(isDraftPreviewEnabled({})).toBe(false);
  });
});

describe("isDraftHostAllowed", () => {
  const env = { DECO_DRAFT_PREVIEW_HOST: "fila.vtex.app, localhost:3100" };

  it("matches listed hosts verbatim, port included, case-insensitively", () => {
    expect(isDraftHostAllowed("fila.vtex.app", env)).toBe(true);
    expect(isDraftHostAllowed("FILA.VTEX.APP", env)).toBe(true);
    expect(isDraftHostAllowed("localhost:3100", env)).toBe(true);
  });

  it("rejects everything else — the production domain on the same build", () => {
    expect(isDraftHostAllowed("fila.com.br", env)).toBe(false);
    expect(isDraftHostAllowed("localhost", env)).toBe(false); // port matters
    expect(isDraftHostAllowed(null, env)).toBe(false);
    expect(isDraftHostAllowed("fila.vtex.app", {})).toBe(false);
  });
});

describe("resolveDraftDecofile", () => {
  it("uses the default deco suffixes when none are configured", async () => {
    const calls: string[] = [];
    await resolveDraftDecofile({
      pointer: "abc@v1",
      env: { DECO_DRAFT_PREVIEW_HOST: "preview.example" },
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });
    expect(calls).toEqual(
      DEFAULT_SANDBOX_ORIGIN_SUFFIXES.map(
        (sfx) => `${sfx.includes("localhost") ? "http" : "https"}://abc${sfx}/_sandbox/decofile`,
      ),
    );
  });

  it("fetches the sandbox decofile and returns it", async () => {
    const calls: string[] = [];
    const blocks = await resolveDraftDecofile({
      pointer: "abc@v1",
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
      pointer: "abc@v1",
      env: { DECO_SANDBOX_ORIGIN_SUFFIXES: ".preview-studio.decocms.com" },
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

    const a = await resolveDraftDecofile({ pointer: "abc@v1", env: ENV_ON, fetchImpl });
    const b = await resolveDraftDecofile({ pointer: "abc@v1", env: ENV_ON, fetchImpl });
    expect(fetches).toBe(1);
    expect(b).toBe(a);

    await resolveDraftDecofile({ pointer: "abc@v2", env: ENV_ON, fetchImpl });
    expect(fetches).toBe(2);
  });

  it("bounds the cache so multi-MB decofiles can't accumulate", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return jsonResponse({ n: fetches });
    }) as unknown as typeof fetch;

    for (const v of ["v1", "v2", "v3", "v4"]) {
      await resolveDraftDecofile({ pointer: `abc@${v}`, env: ENV_ON, fetchImpl });
    }
    expect(fetches).toBe(4);

    // v1 was evicted (cap is 3), so it must re-fetch rather than serve stale.
    await resolveDraftDecofile({ pointer: "abc@v1", env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5);

    // v4 is still resident.
    await resolveDraftDecofile({ pointer: "abc@v4", env: ENV_ON, fetchImpl });
    expect(fetches).toBe(5);
  });

  it("falls through the suffix list until one origin answers", async () => {
    // A deployment can serve sandboxes from more than one origin (cluster and
    // desktop-link); the handle doesn't say which. The first suffix here is
    // unreachable — the resolver must try the next, not give up.
    const calls: string[] = [];
    const blocks = await resolveDraftDecofile({
      pointer: "abc@v1",
      env: {
        DECO_DRAFT_PREVIEW_HOST: "preview.example",
        DECO_SANDBOX_ORIGIN_SUFFIXES: ".dead.example, .alive.example",
      },
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("dead")) throw new Error("ECONNREFUSED");
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(blocks).toEqual({ ok: true });
    expect(calls).toEqual([
      "https://abc.dead.example/_sandbox/decofile",
      "https://abc.alive.example/_sandbox/decofile",
    ]);
  });

  it("degrades to published on a malformed pointer, without fetching", async () => {
    let called = false;
    const blocks = await resolveDraftDecofile({
      pointer: "a@b@c",
      env: ENV_ON,
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
    expect(called).toBe(false);
  });

  it("degrades to published on a non-2xx sandbox", async () => {
    const blocks = await resolveDraftDecofile({
      pointer: "abc@v1",
      env: ENV_ON,
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
  });

  it("degrades to published when the sandbox is unreachable", async () => {
    const blocks = await resolveDraftDecofile({
      pointer: "abc@v1",
      env: ENV_ON,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
  });

  it("degrades to published on an unparseable body", async () => {
    const blocks = await resolveDraftDecofile({
      pointer: "abc@v1",
      env: ENV_ON,
      fetchImpl: (async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });
    expect(blocks).toBeNull();
  });
});
