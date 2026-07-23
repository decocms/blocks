import { setBlocks } from "@decocms/blocks/cms";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGeoCacheParam,
  createDecoWorkerEntry,
  DECO_ADMIN_FRAME_ANCESTORS,
  DEFAULT_FRAME_ANCESTORS_CSP,
  DEFAULT_SECURITY_HEADERS,
  detectLocationMatcher,
  injectGeoCookies,
} from "./workerEntry";
import { __resetKvHydrationStateForTests } from "./kvHydration";

const EMPTY_ENV = {};
const MOCK_CTX = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
};
const MOCK_SERVER_ENTRY = {
  fetch: async (_req: Request) => new Response("page content", { status: 200 }),
};

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split("; ").map((c) => {
      const [k, ...v] = c.split("=");
      return [k, v.join("=")];
    }),
  );
}

function makeRequest(
  cf: Record<string, string> | undefined,
  headers: Record<string, string> = {},
): Request {
  const req = new Request("https://example.com/", { headers });
  if (cf) {
    Object.defineProperty(req, "cf", { value: cf, configurable: true });
  }
  return req;
}

describe("injectGeoCookies", () => {
  it("strips cf-region from the outgoing Request headers while preserving the value in __cf_geo_region cookie", () => {
    const req = makeRequest(
      { region: "São Paulo", country: "BR" },
      { "cf-region": "São Paulo", "cf-ipcountry": "BR" },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("cf-region")).toBeNull();
    // ASCII CF headers (cf-ipcountry) are still forwarded
    expect(out.headers.get("cf-ipcountry")).toBe("BR");
    // Geo data is preserved as cookies for matchers
    const cookies = parseCookies(out.headers.get("cookie") ?? "");
    expect(cookies.__cf_geo_region).toBe(encodeURIComponent("São Paulo"));
    expect(cookies.__cf_geo_country).toBe("BR");
  });

  it("strips cf-ipcity from the outgoing Request headers while preserving the value in __cf_geo_city cookie", () => {
    const req = makeRequest(
      { city: "Brasília", country: "BR" },
      { "cf-ipcity": "Brasília" },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("cf-ipcity")).toBeNull();
    const cookies = parseCookies(out.headers.get("cookie") ?? "");
    expect(cookies.__cf_geo_city).toBe(encodeURIComponent("Brasília"));
  });

  it("returns the original request unchanged when there is no cf object", () => {
    const req = makeRequest(undefined, { "cf-region": "São Paulo" });

    const out = injectGeoCookies(req);

    // Without cf, we don't build cookies, and we return the original request
    // untouched (so the cf-region header is still present — but that's the
    // caller's pre-existing state, not something we re-introduced).
    expect(out).toBe(req);
  });

  it("returns the original request unchanged when cf has no relevant geo fields", () => {
    const req = makeRequest({ asn: "12345" }, { "cf-region": "São Paulo" });

    const out = injectGeoCookies(req);

    expect(out).toBe(req);
  });

  it("preserves a pre-existing cookie header", () => {
    const req = makeRequest(
      { region: "São Paulo" },
      { cookie: "vtex_segment=abc; another=xyz" },
    );

    const out = injectGeoCookies(req);

    const raw = out.headers.get("cookie") ?? "";
    expect(raw).toContain("vtex_segment=abc");
    expect(raw).toContain("another=xyz");
    expect(raw).toContain("__cf_geo_region=");
  });

  it("forwards non-geo headers untouched", () => {
    const req = makeRequest(
      { region: "Paraná" },
      {
        "user-agent": "test-agent",
        accept: "*/*",
        "x-custom": "value",
        "cf-ray": "9ff5b26cf9bc067a",
      },
    );

    const out = injectGeoCookies(req);

    expect(out.headers.get("user-agent")).toBe("test-agent");
    expect(out.headers.get("accept")).toBe("*/*");
    expect(out.headers.get("x-custom")).toBe("value");
    expect(out.headers.get("cf-ray")).toBe("9ff5b26cf9bc067a");
  });
});

describe("buildGeoCacheParam", () => {
  const cf = { country: "BR", region: "São Paulo", city: "SP" };

  it("returns undefined when granularity is off", () => {
    expect(buildGeoCacheParam(cf, "off")).toBeUndefined();
  });

  it("returns undefined when cf is undefined", () => {
    expect(buildGeoCacheParam(undefined, "city")).toBeUndefined();
  });

  it("returns country only when granularity is country", () => {
    expect(buildGeoCacheParam(cf, "country")).toBe("BR");
  });

  it("returns country|region when granularity is region", () => {
    expect(buildGeoCacheParam(cf, "region")).toBe("BR|São Paulo");
  });

  it("returns country|region|city when granularity is city", () => {
    expect(buildGeoCacheParam(cf, "city")).toBe("BR|São Paulo|SP");
  });

  it("omits missing fields gracefully", () => {
    expect(buildGeoCacheParam({ country: "BR" }, "city")).toBe("BR");
    expect(buildGeoCacheParam({ country: "BR", region: "MG" }, "city")).toBe("BR|MG");
  });

  it("returns undefined when cf has none of country/region/city", () => {
    expect(buildGeoCacheParam({ asn: "12345" }, "city")).toBeUndefined();
  });
});

describe("detectLocationMatcher", () => {
  it("returns true when decofile has a website/matchers/location.ts __resolveType", () => {
    const blocks = {
      "audiences/geo-audience.json": {
        "__resolveType": "website/flags/audience.ts",
        "matcher": { "__resolveType": "website/matchers/location.ts", "includeLocations": [{ "country": "BR" }] },
      },
    };
    expect(detectLocationMatcher(blocks)).toBe(true);
  });

  it("returns false when decofile has no location matcher", () => {
    const blocks = {
      "audiences/device-audience.json": {
        "__resolveType": "website/flags/audience.ts",
        "matcher": { "__resolveType": "website/matchers/device.ts" },
      },
    };
    expect(detectLocationMatcher(blocks)).toBe(false);
  });

  it("returns false for an empty decofile", () => {
    expect(detectLocationMatcher({})).toBe(false);
  });

  it("returns true when the matcher is nested deeply", () => {
    const blocks = {
      "pages/home.json": {
        "variant": {
          "matcher": { "__resolveType": "website/matchers/location.ts" },
        },
      },
    };
    expect(detectLocationMatcher(blocks)).toBe(true);
  });

  it("returns false when location.ts appears only in a non-resolveType string value (no false positive)", () => {
    const blocks = {
      "content/help.json": {
        "__resolveType": "website/sections/RichText.tsx",
        "body": "This page is controlled by website/matchers/location.ts for geo targeting.",
      },
    };
    expect(detectLocationMatcher(blocks)).toBe(false);
  });
});

describe("CMS redirects", () => {
  afterEach(() => {
    setBlocks({});
    __resetKvHydrationStateForTests();
  });

  it("returns a 301 redirect for a permanent redirect block", async () => {
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/old", to: "/new", type: "permanent" }],
      },
    });
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });
    const res = await worker.fetch(
      new Request("https://example.com/old"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/new");
  });

  it("redirects ?asJson requests too (does not fall through to page resolver)", async () => {
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/old", to: "/new", type: "permanent" }],
      },
    });
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });
    const res = await worker.fetch(
      new Request("https://example.com/old?asJson"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/new");
  });

  it("URI-encodes the Location header for non-ASCII destinations", async () => {
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/promo", to: "/promoção", type: "temporary" }],
      },
    });
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });
    const res = await worker.fetch(
      new Request("https://example.com/promo"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/promo%C3%A7%C3%A3o");
  });

  it("returns a 302 redirect for a temporary redirect block", async () => {
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/promo", to: "/sale", type: "temporary" }],
      },
    });
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });
    const res = await worker.fetch(
      new Request("https://example.com/promo"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sale");
  });

  it("falls through to serverEntry for paths with no redirect", async () => {
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/old", to: "/new", type: "permanent" }],
      },
    });
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });
    const res = await worker.fetch(
      new Request("https://example.com/other"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res.status).toBe(200);
  });

  it("picks up new redirects after setBlocks hot-reload", async () => {
    setBlocks({});
    const worker = createDecoWorkerEntry(MOCK_SERVER_ENTRY, { observability: false });

    // First request with no redirects — falls through
    const res1 = await worker.fetch(
      new Request("https://example.com/v1"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res1.status).toBe(200);

    // Hot-reload: add a redirect
    setBlocks({
      "redirect-1": {
        __resolveType: "website/loaders/redirect.ts",
        redirects: [{ from: "/v1", to: "/v2", type: "permanent" }],
      },
    });

    // Same path should now redirect
    const res2 = await worker.fetch(
      new Request("https://example.com/v1"),
      EMPTY_ENV,
      MOCK_CTX,
    );
    expect(res2.status).toBe(301);
    expect(res2.headers.get("Location")).toBe("/v2");
  });
});

describe("security headers — frame-ancestors default", () => {
  afterEach(() => {
    __resetKvHydrationStateForTests();
    setBlocks({});
  });

  const HTML_SERVER_ENTRY = {
    fetch: async (_req: Request) =>
      new Response("<html>hi</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  };

  it("does NOT ship X-Frame-Options (frame-ancestors supersedes it)", () => {
    expect(DEFAULT_SECURITY_HEADERS["X-Frame-Options"]).toBeUndefined();
  });

  it("allows the deco studio to embed the storefront by default", () => {
    expect(DEFAULT_FRAME_ANCESTORS_CSP).toContain("frame-ancestors");
    expect(DECO_ADMIN_FRAME_ANCESTORS).toContain("https://studio.decocms.com");
    expect(DECO_ADMIN_FRAME_ANCESTORS).toContain("https://*.decocms.com");
    expect(DECO_ADMIN_FRAME_ANCESTORS).toContain("'self'");
  });

  it("applies the default frame-ancestors CSP on HTML responses and drops X-Frame-Options", async () => {
    const worker = createDecoWorkerEntry(HTML_SERVER_ENTRY);
    const res = await worker.fetch(new Request("https://example.com/"), EMPTY_ENV, MOCK_CTX);
    expect(res.headers.get("Content-Security-Policy")).toBe(DEFAULT_FRAME_ANCESTORS_CSP);
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    // Other defaults are still present.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("lets a site override the frame-ancestors CSP via securityHeaders", async () => {
    const worker = createDecoWorkerEntry(HTML_SERVER_ENTRY, {
      securityHeaders: { "Content-Security-Policy": "frame-ancestors 'none'" },
    });
    const res = await worker.fetch(new Request("https://example.com/"), EMPTY_ENV, MOCK_CTX);
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });

  it("emits the full site CSP report-only alongside the enforced frame-ancestors", async () => {
    const worker = createDecoWorkerEntry(HTML_SERVER_ENTRY, {
      csp: ["default-src 'self'", "img-src 'self' https:"],
    });
    const res = await worker.fetch(new Request("https://example.com/"), EMPTY_ENV, MOCK_CTX);
    expect(res.headers.get("Content-Security-Policy")).toBe(DEFAULT_FRAME_ANCESTORS_CSP);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBe(
      "default-src 'self'; img-src 'self' https:",
    );
  });

  it("omits all security headers when securityHeaders is false", async () => {
    const worker = createDecoWorkerEntry(HTML_SERVER_ENTRY, { securityHeaders: false });
    const res = await worker.fetch(new Request("https://example.com/"), EMPTY_ENV, MOCK_CTX);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
  });
});
