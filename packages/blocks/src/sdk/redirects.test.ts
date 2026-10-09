/**
 * Redirect semantics, pinned to the Fresh loaders and handlers this module
 * replaced (deco-cx/apps `website/loaders/redirectsFromCsv.ts`,
 * `website/handlers/router.ts`, `website/handlers/redirect.ts`).
 *
 * The rows are real lines of a storefront's `redirects.csv` (5 835 rows), and
 * every case below is a URL where the TanStack port answered differently from
 * the Fresh site it replaced — three of them as an infinite loop on a live
 * product page.
 */
import { describe, expect, it } from "vitest";
import {
  addRedirects,
  loadRedirects,
  matchRedirect,
  normalizePath,
  parseRedirectsCsv,
  redirectLocation,
  splitExactRedirects,
} from "./redirects";

const fromCsv = (csv: string, options?: Parameters<typeof parseRedirectsCsv>[1]) => {
  const map = loadRedirects({});
  addRedirects(map, parseRedirectsCsv(csv, options));
  return map;
};

describe("source matching is byte for byte, as Fresh's router", () => {
  it("does not fold case — a rule from /Calca-x/p to /calca-x/p is a redirect, not a loop", () => {
    // Three live PDPs looped on this: lower-casing the source made the key
    // equal to its own target.
    const map = fromCsv(
      "from,to,type\n/Calca-Linho-Santorini-Off-White-0077631037/p,/calca-linho-santorini-off-white-0077631037/p,PERMANENT\n",
    );

    expect(matchRedirect("/calca-linho-santorini-off-white-0077631037/p", map)).toBeNull();
    expect(matchRedirect("/Calca-Linho-Santorini-Off-White-0077631037/p", map)).toMatchObject({
      to: "/calca-linho-santorini-off-white-0077631037/p",
      status: 307,
    });
  });

  it("keeps rows that differ only by case or trailing slash as distinct rules", () => {
    // Folding collapsed these onto one key, last row winning: the first URL
    // was sent to the second row's destination.
    const map = fromCsv(
      [
        "from,to,type",
        "/meia-pima-cano-alto-casual-poa-preta-0075365040/p,/meia-canelada-pima-cinza-0102768020/p,permanent",
        "/meia-pima-cano-alto-casual-poa-preta-0075365040/p/,/meia-social-modal-marrom-0058971035/p,permanent",
        "/Camiseta-Basica-0001/p,/camisetas/basica,permanent",
        "/camiseta-basica-0001/p,/camisetas/outra,permanent",
      ].join("\n"),
    );

    expect(matchRedirect("/meia-pima-cano-alto-casual-poa-preta-0075365040/p", map)?.to).toBe(
      "/meia-canelada-pima-cinza-0102768020/p",
    );
    expect(matchRedirect("/meia-pima-cano-alto-casual-poa-preta-0075365040/p/", map)?.to).toBe(
      "/meia-social-modal-marrom-0058971035/p",
    );
    expect(matchRedirect("/Camiseta-Basica-0001/p", map)?.to).toBe("/camisetas/basica");
    expect(matchRedirect("/camiseta-basica-0001/p", map)?.to).toBe("/camisetas/outra");
  });

  it("matches the percent-encoded pathname the request carries", () => {
    // `URL.pathname` is percent-encoded, so a source written raw with non-ASCII
    // never matches (same in Fresh); one written encoded does.
    const map = fromCsv("from,to\n/calcas/paletos/maleável,/linha-maleavel\n/caf%C3%A9,/cafe\n");
    expect(matchRedirect("/calcas/paletos/male%C3%A1vel", map)).toBeNull();
    expect(matchRedirect("/caf%C3%A9", map)?.to).toBe("/cafe");
  });

  it("never matches a source without a leading slash", () => {
    const map = fromCsv("from,to\ncamisa-roma-linho-verde-0060535048,/roupas/camisas\n");
    expect(matchRedirect("/camisa-roma-linho-verde-0060535048", map)).toBeNull();
  });

  it("strips the origin of an absolute source and keeps the rest as written", () => {
    expect(normalizePath("https://www.example.com/Old/")).toBe("/Old/");
    expect(normalizePath("https://www.example.com/x?map=c")).toBe("/x?map=c");
    expect(normalizePath("/Keep-Case/")).toBe("/Keep-Case/");
    const map = fromCsv("from,to\nhttps://www.example.com/Old/,/new\n");
    expect(matchRedirect("/Old/", map)?.to).toBe("/new");
    expect(matchRedirect("/old", map)).toBeNull();
  });

  it("scans glob patterns case-sensitively too", () => {
    const map = fromCsv("from,to\n/Blog/*,/news/*\n");
    expect(matchRedirect("/Blog/post-1", map)?.to).toBe("/news/post-1");
    expect(matchRedirect("/blog/post-1", map)).toBeNull();
  });
});

describe("query-scoped sources", () => {
  const map = fromCsv(
    [
      "from,to,type",
      "/kits-3-camisas-kit0000008010/p,/camisa-paris-branca-0100441014/p,PERMANENT",
      "/kits-3-camisas-kit0000008010/p?skuId=4432,/roupas/kits,PERMANENT",
      "/garrafa-kouda-preta-0059962040/p?listName=Kouda,/roupas/acessorios,PERMANENT",
    ].join("\n"),
  );

  it("matches pathname + search before the bare pathname", () => {
    expect(matchRedirect("/kits-3-camisas-kit0000008010/p", map, "?skuId=4432")?.to).toBe(
      "/roupas/kits",
    );
    expect(matchRedirect("/kits-3-camisas-kit0000008010/p", map)?.to).toBe(
      "/camisa-paris-branca-0100441014/p",
    );
    expect(matchRedirect("/kits-3-camisas-kit0000008010/p", map, "?skuId=1")?.to).toBe(
      "/camisa-paris-branca-0100441014/p",
    );
  });

  it("is unreachable from the bare pathname", () => {
    expect(matchRedirect("/garrafa-kouda-preta-0059962040/p", map)).toBeNull();
    expect(matchRedirect("/garrafa-kouda-preta-0059962040/p", map, "?listName=Kouda")?.to).toBe(
      "/roupas/acessorios",
    );
  });
});

describe("status", () => {
  const statusOf = (type: string) => parseRedirectsCsv(`from,to,type\n/a,/b,${type}\n`)[0].status;

  it("is 301 for `permanent` and 307 for everything else, compared exactly as Fresh does", () => {
    expect(statusOf("permanent")).toBe(301);
    expect(statusOf("301")).toBe(301);
    // 82% of the real file spells it this way, and the Fresh site served 307.
    expect(statusOf("PERMANENT")).toBe(307);
    expect(statusOf("temporary")).toBe(307);
    expect(statusOf("")).toBe(307);
    expect(parseRedirectsCsv("from,to\n/a,/b\n")[0].status).toBe(307);
  });

  it("is 307 for a temporary CMS block too", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/promo", to: "/sale", type: "temporary" },
      },
    });
    expect(matchRedirect("/promo", map)?.status).toBe(307);
  });

  it("defaults rows without a type to 301 under forcePermanentRedirects", () => {
    const map = fromCsv("from,to\n/a,/b\n/c,/d,temporary\n", { forcePermanentRedirects: true });
    expect(matchRedirect("/a", map)?.status).toBe(301);
    expect(matchRedirect("/c", map)?.status).toBe(307);
  });
});

describe("CSV columns", () => {
  it("reads type and discardQueryParameters by value, in any column", () => {
    const rows = parseRedirectsCsv(
      "from,to,type\n/a,/b,true,permanent\n/c,/d,permanent,false\n/e,/f,true\n",
    );
    expect(rows).toEqual([
      { from: "/a", to: "/b", status: 301, discardQueryParameters: true },
      { from: "/c", to: "/d", status: 301 },
      { from: "/e", to: "/f", status: 307, discardQueryParameters: true },
    ]);
  });

  it("splits on a semicolon outside quotes and on every comma, like Fresh", () => {
    expect(parseRedirectsCsv("from;to;type\n/a;/b;permanent\n")).toEqual([
      { from: "/a", to: "/b", status: 301 },
    ]);
    expect(parseRedirectsCsv('from,to\n"/a;x",/b\n')).toEqual([
      { from: '"/a;x"', to: "/b", status: 307 },
    ]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseRedirectsCsv("from,to,type\r\n/a,/b,permanent\r\n")).toEqual([
      { from: "/a", to: "/b", status: 301 },
    ]);
  });

  it("carries discardQueryParameters from a CMS block entry", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [{ from: "/a", to: "/b", type: "permanent", discardQueryParameters: true }],
      },
    });
    expect(matchRedirect("/a", map)).toEqual({
      from: "/a",
      to: "/b",
      status: 301,
      discardQueryParameters: true,
    });
  });
});

describe("self-redirects are dropped at load time", () => {
  it("drops a row that points at itself", () => {
    expect(parseRedirectsCsv("from,to\n/a,/a\n")).toEqual([]);
  });

  it("drops an absolute source that collapses onto its target", () => {
    expect(parseRedirectsCsv("from,to\nhttp://blog.example.com/,/\n")).toEqual([]);
  });

  it("drops a self-redirect declared as a CMS block", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/loop", to: "/loop", type: "permanent" },
      },
    });
    expect(matchRedirect("/loop", map)).toBeNull();
  });

  it("keeps a redirect that only changes case or trailing slash — those are different URLs", () => {
    expect(parseRedirectsCsv("from,to\n/A,/a\n/b/,/b\n")).toHaveLength(2);
  });
});

describe("redirectLocation", () => {
  it("appends the request's query string sorted by key, so campaign parameters survive", () => {
    // What the Fresh site answered for `?utm_source=qa&gclid=x`.
    expect(redirectLocation({ to: "/new" }, "?utm_source=qa&gclid=x")).toBe(
      "/new?gclid=x&utm_source=qa",
    );
    expect(redirectLocation({ to: "/new?a=1" }, "?b=2")).toBe("/new?a=1&b=2");
    // Pairs are kept as sent: no re-encoding, duplicates keep their order.
    expect(redirectLocation({ to: "/n" }, "?q=a%20b&q=c&a")).toBe("/n?a&q=a%20b&q=c");
    expect(redirectLocation({ to: "/new" }, "")).toBe("/new");
    expect(redirectLocation({ to: "/new" })).toBe("/new");
  });

  it("honors discardQueryParameters", () => {
    expect(redirectLocation({ to: "/new", discardQueryParameters: true }, "?utm_source=qa")).toBe(
      "/new",
    );
  });

  it("leaves an escape already in `to` alone instead of double-encoding it", () => {
    // `encodeURI` turned this into `%2520`, and the CDN answered 403.
    const to = "https://cdn.example.com/Regulamento%20Oficina%20Reserva%20e%20Livelo.pdf";
    expect(redirectLocation({ to })).toBe(to);
  });

  it("percent-encodes what a header cannot carry", () => {
    expect(redirectLocation({ to: "/promoção" })).toBe("/promo%C3%A7%C3%A3o");
    expect(redirectLocation({ to: "/a b" })).toBe("/a%20b");
    expect(redirectLocation({ to: "/emoji-😀" })).toBe("/emoji-%F0%9F%98%80");
  });
});

describe("splitExactRedirects", () => {
  it("keys KV by the source as written and carries discardQueryParameters", () => {
    const { exact } = splitExactRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "https://site.com/Old/", to: "/new" },
          { from: "/drop", to: "/kept", type: "permanent", discardQueryParameters: true },
        ],
      },
    });
    expect(exact).toEqual([
      { path: "/Old/", to: "/new", status: 307 },
      { path: "/drop", to: "/kept", status: 301, discardQueryParameters: true },
    ]);
  });

  it("keeps query-scoped rules in the decofile, where the in-memory lookup can see them", () => {
    const input = {
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [
          { from: "/x?map=c", to: "/scoped" },
          { from: "/x", to: "/bare" },
        ],
      },
    };
    const { blocks, exact } = splitExactRedirects(input);
    expect(exact).toEqual([{ path: "/x", to: "/bare", status: 307 }]);
    expect(matchRedirect("/x", loadRedirects(blocks), "?map=c")?.to).toBe("/scoped");
    expect(matchRedirect("/x", loadRedirects(blocks))).toBeNull();
  });

  it("drops a self-redirect instead of writing it to KV", () => {
    const { exact } = splitExactRedirects({
      r: { __resolveType: "website/loaders/redirects.ts", redirects: [{ from: "/a", to: "/a" }] },
    });
    expect(exact).toEqual([]);
  });
});
