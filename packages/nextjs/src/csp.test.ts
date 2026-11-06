// @vitest-environment node
/** What Studio needs in a site's CSP: its origins in script-src and frame-ancestors, one list with the Studio channel's. */
import { afterEach, describe, expect, it } from "vitest";
import { withStudioCsp } from "./csp";

const ANCESTORS =
  "frame-ancestors 'self' https://studio.decocms.com https://studio-stg.decocms.com https://decocms.com https://*.decocms.com https://*.deco.studio";
const DEFAULTS = "https://studio.decocms.com https://studio-stg.decocms.com";

describe("withStudioCsp", () => {
  const env = process.env.DECO_STUDIO_ORIGIN;
  afterEach(() => {
    if (env === undefined) delete process.env.DECO_STUDIO_ORIGIN;
    else process.env.DECO_STUDIO_ORIGIN = env;
  });

  it("adds Studio's origins to script-src and a frame-ancestors when the policy has none", () => {
    delete process.env.DECO_STUDIO_ORIGIN;
    expect(withStudioCsp("script-src 'self' 'nonce-x'; object-src 'none'")).toEqual([
      `script-src 'self' 'nonce-x' ${DEFAULTS}`,
      "object-src 'none'",
      ANCESTORS,
    ]);
  });

  it("a policy restricting scripts through default-src gets a script-src with its sources plus Studio's", () => {
    delete process.env.DECO_STUDIO_ORIGIN;
    expect(withStudioCsp(["default-src 'self' https:"], { addFrameAncestors: false })).toEqual([
      "default-src 'self' https:",
      `script-src 'self' https: ${DEFAULTS}`,
    ]);
  });

  it("keeps the site's frame-ancestors, a script-src 'none', and a policy that doesn't restrict scripts", () => {
    expect(withStudioCsp("frame-ancestors 'none'; script-src 'none'")).toEqual([
      "frame-ancestors 'none'",
      "script-src 'none'",
    ]);
    expect(withStudioCsp("img-src https:", { addFrameAncestors: false })).toEqual([
      "img-src https:",
    ]);
  });

  it("uses the same list for both directives: the option, else DECO_STUDIO_ORIGIN", () => {
    process.env.DECO_STUDIO_ORIGIN = "http://localhost:3000";
    expect(withStudioCsp("script-src 'self'")).toEqual([
      "script-src 'self' http://localhost:3000",
      `${ANCESTORS} http://localhost:3000`,
    ]);
    expect(
      withStudioCsp("script-src 'self'", {
        studioOrigins: ["https://studio.example.com"],
        frameAncestors: ["https://editor.example.com"],
        dev: true,
      }),
    ).toEqual([
      "script-src 'self' https://studio.example.com",
      `${ANCESTORS} https://studio.example.com https://editor.example.com http://localhost:* http://127.0.0.1:*`,
    ]);
  });

  it("an empty list adds nothing to script-src", () => {
    expect(withStudioCsp("script-src 'self'", { studioOrigins: [] })).toEqual([
      "script-src 'self'",
      ANCESTORS,
    ]);
  });
});
