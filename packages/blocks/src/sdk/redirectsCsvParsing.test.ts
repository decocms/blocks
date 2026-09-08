/**
 * CSV parsing details that bulk redirect exports depend on: quoted fields and
 * the spelling of the redirect type.
 */
import { describe, expect, it } from "vitest";
import { loadRedirects, matchRedirect, parseRedirectsCsv } from "./redirects";

describe("quoted fields", () => {
  it("does not split on a comma inside a quoted source", () => {
    // Real VTEX export row: the query itself contains a comma.
    const [redirect] = parseRedirectsCsv(
      'from,to,type\n"https://www.example.com/relogios?map=category-1,category-2",/relogios,PERMANENT\n',
    );

    expect(redirect).toMatchObject({ to: "/relogios", status: 301 });
    expect(redirect.from).toBe("/relogios");
  });

  it("does not split on a comma inside a quoted target", () => {
    const [redirect] = parseRedirectsCsv('from,to\n/old,"/new?map=a,b"\n');
    expect(redirect).toMatchObject({ from: "/old", to: "/new?map=a,b" });
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    const [redirect] = parseRedirectsCsv('from,to\n/old,"/new?q=""x"""\n');
    expect(redirect.to).toBe('/new?q="x"');
  });

  it("still handles rows with no quoting at all", () => {
    const map = loadRedirects({});
    expect(parseRedirectsCsv("from,to,type\n/a,/b,permanent\n")).toEqual([
      { from: "/a", to: "/b", status: 301 },
    ]);
    expect(map.exact.size).toBe(0);
  });

  it("cannot rescue an unquoted row whose query holds a comma", () => {
    // Documents the boundary: quoting is what makes a comma literal. An export
    // that omits the quotes is still shredded, and that is the export's bug.
    const [redirect] = parseRedirectsCsv("from,to\n/x?map=a,b\n");
    expect(redirect).toMatchObject({ from: "/x?map=a", to: "b" });
  });
});

describe("redirect type spelling", () => {
  const statusOf = (type: string) => parseRedirectsCsv(`from,to,type\n/a,/b,${type}\n`)[0].status;

  it("reads the CSV type case-insensitively", () => {
    expect(statusOf("PERMANENT")).toBe(301);
    expect(statusOf("Permanent")).toBe(301);
    expect(statusOf("permanent")).toBe(301);
    expect(statusOf("301")).toBe(301);
  });

  it("still defaults to temporary", () => {
    expect(statusOf("TEMPORARY")).toBe(302);
    expect(statusOf("temporary")).toBe(302);
    expect(statusOf("")).toBe(302);
    expect(parseRedirectsCsv("from,to\n/a,/b\n")[0].status).toBe(302);
  });

  it("reads the CMS block type case-insensitively too", () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/a", to: "/b", type: "PERMANENT" },
      },
    });
    expect(matchRedirect("/a", map)?.status).toBe(301);
  });
});
