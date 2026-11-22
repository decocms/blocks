// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildCSPHeaderValue, buildRenderCSP, generateCSPNonce } from "./csp";

describe("buildRenderCSP", () => {
  const csp = buildRenderCSP({ nonce: "TESTNONCE123" });
  const directives = Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );

  it("locks the default source down to nothing", () => {
    expect(directives["default-src"]).toBe("'none'");
  });

  it("authorizes scripts by nonce and NOT by unsafe-inline", () => {
    // The whole point: a nonce authorizes only the framework's own
    // <script nonce=…>. Inline event-handler attributes (onerror/onload) are
    // never matched by a nonce, so the reflected-XSS payload cannot execute.
    expect(directives["script-src"]).toBe("'nonce-TESTNONCE123'");
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("keeps non-script directives permissive so the preview still paints", () => {
    // Inline styles are not a JS-execution vector; images/fonts come from CDNs.
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["img-src"]).toContain("https:");
    expect(directives["font-src"]).toContain("https:");
  });

  it("blocks base-uri and form-action hijacking", () => {
    expect(directives["base-uri"]).toBe("'none'");
    expect(directives["form-action"]).toBe("'none'");
  });

  it("frames only 'self' + admin origins (clickjacking guard)", () => {
    expect(directives["frame-ancestors"]).toContain("'self'");
    expect(directives["frame-ancestors"]).toContain("https://admin.deco.cx");
  });

  it("honors a custom admin-origin allowlist", () => {
    const custom = buildRenderCSP({
      nonce: "n",
      adminOrigins: ["https://studio.decocms.com"],
    });
    expect(custom).toContain("frame-ancestors 'self' https://studio.decocms.com");
    expect(custom).not.toContain("https://admin.deco.cx");
  });
});

describe("generateCSPNonce", () => {
  it("returns a non-empty base64 string", () => {
    const nonce = generateCSPNonce();
    expect(nonce.length).toBeGreaterThan(0);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("returns a fresh value each call", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateCSPNonce()));
    expect(seen.size).toBe(100);
  });
});

describe("buildCSPHeaderValue (unchanged, frame-ancestors only)", () => {
  it("still returns only frame-ancestors", () => {
    expect(buildCSPHeaderValue()).toMatch(/^frame-ancestors /);
  });
});
