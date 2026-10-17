// @vitest-environment node
/** Studio's origins: one list for the Studio bridge, withDeco()'s dev origins and a site's own frame-ancestors. */
import { describe, expect, it } from "vitest";
import { isStudioOrigin, STUDIO_FRAME_ANCESTORS, STUDIO_ORIGINS } from "./studio";

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
