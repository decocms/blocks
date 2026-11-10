// @vitest-environment node
/** Studio's origins: one list for the Studio bridge, withDeco()'s dev origins and a site's own frame-ancestors. */

import {
  DEFAULT_STUDIO_ORIGIN,
  DEFAULT_STUDIO_ORIGINS as PROTOCOL_ORIGINS,
  STUDIO_PAGE_REFRESH as PROTOCOL_PAGE_REFRESH,
} from "@decocms/blocks/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STUDIO_ORIGINS,
  isStudioOrigin,
  STUDIO_FRAME_ANCESTORS,
  STUDIO_ORIGIN,
  STUDIO_ORIGINS,
  STUDIO_PAGE_REFRESH,
  studioOrigins,
} from "./studio";

describe("STUDIO_ORIGINS", () => {
  it("pins the values", () => {
    expect(STUDIO_ORIGINS).toEqual([
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
      "https://decocms.com",
      "https://*.decocms.com",
    ]);
  });

  it("is frozen: no caller can widen it for everyone", () => {
    expect(Object.isFrozen(STUDIO_ORIGINS)).toBe(true);
    expect(Object.isFrozen(STUDIO_FRAME_ANCESTORS)).toBe(true);
  });

  it("each entry is a CSP source expression a URL parser reads as https", () => {
    for (const origin of STUDIO_ORIGINS) {
      expect(origin).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+$/);
    }
  });
});

describe("STUDIO_FRAME_ANCESTORS", () => {
  it("pins the values: the site itself, Studio's origins and v7's *.deco.studio", () => {
    expect(STUDIO_FRAME_ANCESTORS).toEqual([
      "'self'",
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
      "https://decocms.com",
      "https://*.decocms.com",
      "https://*.deco.studio",
    ]);
  });

  it("joins into a frame-ancestors directive", () => {
    expect(`frame-ancestors ${STUDIO_FRAME_ANCESTORS.join(" ")}`).toBe(
      "frame-ancestors 'self' https://studio.decocms.com https://studio-stg.decocms.com " +
        "https://decocms.com https://*.decocms.com https://*.deco.studio",
    );
  });
});

describe("isStudioOrigin", () => {
  it.each([
    "https://studio.decocms.com",
    "https://studio-stg.decocms.com",
    "https://decocms.com",
    "https://admin.decocms.com",
  ])("%s is Studio", (origin) => {
    expect(isStudioOrigin(origin)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "",
    "null",
    "http://studio.decocms.com",
    "https://studio.decocms.com:8443",
    "https://studio.decocms.com/",
    "https://studio.decocms.com/path",
    "https://decocms.com.attacker.example",
    "https://attackerdecocms.com",
    "https://user@studio.decocms.com",
    "https://studio.deco.cx",
    "https://store.example.com",
  ])("%j isn't", (origin) => {
    expect(isStudioOrigin(origin)).toBe(false);
  });
});

describe("studioOrigins (the origins the Studio channel trusts and the CSP allows)", () => {
  const env = process.env.DECO_STUDIO_ORIGIN;
  afterEach(() => {
    if (env === undefined) delete process.env.DECO_STUDIO_ORIGIN;
    else process.env.DECO_STUDIO_ORIGIN = env;
  });

  it("defaults to Studio's production and staging origins, the ones the protocol names", () => {
    delete process.env.DECO_STUDIO_ORIGIN;
    expect(STUDIO_ORIGIN).toBe("https://studio.decocms.com");
    expect(STUDIO_ORIGIN).toBe(DEFAULT_STUDIO_ORIGIN);
    expect(DEFAULT_STUDIO_ORIGINS).toEqual([
      "https://studio.decocms.com",
      "https://studio-stg.decocms.com",
    ]);
    expect(DEFAULT_STUDIO_ORIGINS).toEqual(PROTOCOL_ORIGINS);
    expect(Object.isFrozen(DEFAULT_STUDIO_ORIGINS)).toBe(true);
    expect(studioOrigins()).toEqual(DEFAULT_STUDIO_ORIGINS);
    // Each default is one of the frame-ancestors Studio already had.
    for (const origin of DEFAULT_STUDIO_ORIGINS) expect(STUDIO_ORIGINS).toContain(origin);
  });

  it("DECO_STUDIO_ORIGIN, comma-separated, replaces the default; the binding option replaces both", () => {
    process.env.DECO_STUDIO_ORIGIN = "http://localhost:3000";
    expect(studioOrigins()).toEqual(["http://localhost:3000"]);
    process.env.DECO_STUDIO_ORIGIN = " http://localhost:3000, https://studio-stg.decocms.com/ ,";
    expect(studioOrigins()).toEqual(["http://localhost:3000", "https://studio-stg.decocms.com"]);
    expect(studioOrigins(["https://studio.example.com"])).toEqual(["https://studio.example.com"]);
    expect(studioOrigins([])).toEqual([]);
    process.env.DECO_STUDIO_ORIGIN = " ";
    expect(studioOrigins()).toEqual(DEFAULT_STUDIO_ORIGINS);
  });

  it("keeps exact http(s) origins only: never a wildcard, a path, a CSP keyword or a separator", () => {
    process.env.DECO_STUDIO_ORIGIN = [
      "https://*.decocms.com",
      "https://studio.decocms.com/path",
      "'unsafe-inline'",
      "https://a.com; script-src *",
      "*",
      "javascript:alert(1)",
      "studio.decocms.com",
      "https://user@studio.decocms.com",
      "https://Studio.decocms.com",
    ].join(",");
    expect(studioOrigins()).toEqual([]);
    expect(
      studioOrigins(["https://*.decocms.com", "http://[::1]:3000", "http://a.com:8080"]),
    ).toEqual(["http://[::1]:3000", "http://a.com:8080"]);
  });
});

describe("STUDIO_PAGE_REFRESH", () => {
  it("is the protocol's name, where Studio's HTML swap looks for the page's refresh", () => {
    expect(STUDIO_PAGE_REFRESH).toBe(PROTOCOL_PAGE_REFRESH);
    expect(STUDIO_PAGE_REFRESH).toBe("__decoStudioRefresh");
  });
});
