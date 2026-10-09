/**
 * `semantics: "legacy"` — the default. Pins what sites already on `@decocms/*`
 * answer (case- and trailing-slash-insensitive match, 302 for temporary, query
 * dropped), so turning on `"fresh"` for one site changes nothing for the
 * others. The rows mirror real rules of two such storefronts.
 *
 * The only differences from before are rules that could never be served (a
 * self-redirect loops forever) and a `Location` that `encodeURI` double-encoded.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  addRedirects,
  getRedirectSemantics,
  loadRedirects,
  matchRedirect,
  normalizePath,
  parseRedirectsCsv,
  redirectLocation,
  selectExactRedirect,
  setRedirectSemantics,
  splitExactRedirects,
} from "./redirects";

afterEach(() => setRedirectSemantics("legacy"));

const block = (redirects: Array<Record<string, unknown>>) =>
  loadRedirects({ r: { __resolveType: "website/loaders/redirects.ts", redirects } });

describe("default", () => {
  it("is legacy", () => {
    expect(getRedirectSemantics()).toBe("legacy");
  });
});

describe("matching folds case and a trailing slash", () => {
  const map = block([
    { from: "/baixeoapp", to: "/baixe-o-app", type: "permanent" },
    { from: "/Loja/Produto/123", to: "/kit-123", type: "permanent" },
  ]);

  it("matches any case and with or without a trailing slash", () => {
    for (const path of ["/baixeoapp", "/BaixeoApp", "/baixeoapp/", "/BAIXEOAPP/"]) {
      expect(matchRedirect(path, map)).toMatchObject({ to: "/baixe-o-app", status: 301 });
    }
    expect(matchRedirect("/loja/produto/123", map)?.to).toBe("/kit-123");
  });

  it("scans globs case-insensitively", () => {
    const globs = block([{ from: "/PharolGranado/*", to: "/blog/*", type: "permanent" }]);
    expect(matchRedirect("/pharolgranado/post-1", globs)?.to).toBe("/blog/post-1");
    expect(matchRedirect("/PharolGranado/post-1", globs)?.to).toBe("/blog/post-1");
  });

  it("keys an absolute source by its pathname alone", () => {
    expect(normalizePath("https://www.example.com/Old/?x=1")).toBe("/old");
    const abs = block([{ from: "https://www.example.com/Old/?x=1", to: "/new" }]);
    expect(matchRedirect("/old", abs)?.to).toBe("/new");
  });

  it("adds the leading slash a source was written without", () => {
    const map = block([{ from: "camisa-roma", to: "/roupas/camisas", type: "permanent" }]);
    expect(matchRedirect("/camisa-roma", map)?.to).toBe("/roupas/camisas");
  });
});

describe("status", () => {
  it("is 301 for permanent and 302 for anything else", () => {
    const map = block([
      { from: "/a", to: "/b", type: "permanent" },
      { from: "/exemplo", to: "https://www.google.com", type: "temporary" },
      { from: "/c", to: "/d" },
    ]);
    expect(matchRedirect("/a", map)?.status).toBe(301);
    expect(matchRedirect("/exemplo", map)?.status).toBe(302);
    expect(matchRedirect("/c", map)?.status).toBe(302);
  });

  it("is 302 for a CSV row that is not `permanent`/`301`", () => {
    const map = loadRedirects({});
    addRedirects(map, parseRedirectsCsv("from,to,type\n/a,/b,PERMANENT\n/c,/d,301\n/e,/f\n"));
    expect(matchRedirect("/a", map)?.status).toBe(302);
    expect(matchRedirect("/c", map)?.status).toBe(301);
    expect(matchRedirect("/e", map)?.status).toBe(302);
  });
});

describe("Location", () => {
  it("drops the request's query string", () => {
    expect(redirectLocation({ to: "/baixe-o-app" }, "?utm_source=a&gclid=x")).toBe("/baixe-o-app");
  });

  it("encodes what a header cannot carry, without double-encoding an escape", () => {
    expect(redirectLocation({ to: "/promoção" })).toBe("/promo%C3%A7%C3%A3o");
    expect(redirectLocation({ to: "/Regulamento%20Oficina.pdf" })).toBe(
      "/Regulamento%20Oficina.pdf",
    );
  });
});

describe("rules that can never be served are dropped", () => {
  it("drops a rule whose source equals its target as written", () => {
    const map = block([{ from: "kit-de-sabonetes", to: "kit-de-sabonetes", type: "permanent" }]);
    expect(matchRedirect("/kit-de-sabonetes", map)).toBeNull();
  });

  it("drops a rule that folding turns into a self-redirect", () => {
    const map = block([
      { from: "/Calca/p", to: "/calca/p", type: "permanent" },
      { from: "/x/", to: "/x?utm_source=a", type: "permanent" },
    ]);
    expect(matchRedirect("/Calca/p", map)).toBeNull();
    expect(matchRedirect("/calca/p", map)).toBeNull();
    expect(matchRedirect("/x", map)).toBeNull();
  });

  it("keeps a rule to another host with the same path", () => {
    const map = block([{ from: "/exemplo", to: "https://www.google.com/exemplo" }]);
    expect(matchRedirect("/exemplo", map)?.to).toBe("https://www.google.com/exemplo");
  });
});

describe("KV-keyed exact rules", () => {
  it("serve the last rule written for a key, temporary as 302", () => {
    const { exact } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "/meia/p", to: "/a" },
          { from: "/Meia/p/", to: "/b" },
        ],
      },
    });
    expect(exact).toHaveLength(1);
    const value = [...exact[0].shadowed!, exact[0]];
    for (const path of ["/meia/p", "/MEIA/p", "/meia/p/"]) {
      expect(selectExactRedirect(value, path)).toMatchObject({ to: "/b", status: 302 });
    }
  });

  it("read a value written before `from` was stored", () => {
    expect(selectExactRedirect({ to: "/new", status: 301 }, "/Old")).toMatchObject({
      to: "/new",
      status: 301,
    });
  });

  it("never serve a folded self-redirect", () => {
    expect(
      selectExactRedirect({ from: "/Calca/p", to: "/calca/p", status: 301 }, "/calca/p"),
    ).toBeNull();
  });
});

describe("switching to fresh", () => {
  it("changes only maps built afterwards", () => {
    const legacy = block([{ from: "/Old", to: "/new" }]);
    setRedirectSemantics("fresh");
    const fresh = block([{ from: "/Old", to: "/new" }]);
    expect(matchRedirect("/old", fresh)).toBeNull();
    expect(matchRedirect("/Old", fresh)?.status).toBe(307);
    setRedirectSemantics("legacy");
    expect(matchRedirect("/old", legacy)?.status).toBe(302);
  });
});
