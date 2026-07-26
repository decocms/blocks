import { describe, expect, it } from "vitest";
import { isActionOrLoaderPath, scanFileForSecrets } from "./audit-secrets";

// All fixtures use a synthetic sentinel — never a real credential.
const FAKE = "FAKE0SECRET0SENTINEL0abcdef1234";

describe("isActionOrLoaderPath", () => {
  it("matches Fresh- and TanStack-style action/loader paths", () => {
    expect(isActionOrLoaderPath("actions/foo.ts")).toBe(true);
    expect(isActionOrLoaderPath("src/actions/foo.ts")).toBe(true);
    expect(isActionOrLoaderPath("src/loaders/bar/baz.ts")).toBe(true);
  });
  it("ignores non-action/loader paths", () => {
    expect(isActionOrLoaderPath("src/sections/Hero.tsx")).toBe(false);
    expect(isActionOrLoaderPath("src/components/actionsMenu.tsx")).toBe(false);
  });
});

describe("scanFileForSecrets — hardcoded credential in an action", () => {
  it("flags a hardcoded Bearer token", () => {
    const src = `export default async function h() {
  const headers = { Authorization: "Bearer ${FAKE}" };
  return fetch("https://api.example.com", { headers });
}`;
    const f = scanFileForSecrets("src/actions/simulate.ts", src);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("hardcoded_bearer_token");
    expect(f[0].severity).toBe("error");
    expect(f[0].line).toBe(2);
  });

  it("flags a keyed secret literal (apiKey/token/secret)", () => {
    const src = `const apiKey = "${FAKE}";\n`;
    const f = scanFileForSecrets("actions/pay.ts", src);
    expect(f.map((x) => x.id)).toContain("hardcoded_secret_literal");
  });

  it("does NOT flag env/context/interpolated reads", () => {
    const src = `const headers = {
  Authorization: \`Bearer \${process.env.API_TOKEN}\`,
  apiKey: ctx.state.config.apiKey,
  token: process.env.TOKEN,
};`;
    expect(scanFileForSecrets("src/actions/ok.ts", src)).toHaveLength(0);
  });

  it("does NOT flag obvious placeholders", () => {
    const src = `const token = "changeme";\nconst apiKey = "xxxxxxxxxxxx";\n`;
    expect(scanFileForSecrets("src/actions/ph.ts", src)).toHaveLength(0);
  });

  it("does NOT scan hardcoded literals OUTSIDE actions/loaders", () => {
    const src = `const apiKey = "${FAKE}";\n`;
    expect(scanFileForSecrets("src/sections/Hero.tsx", src)).toHaveLength(0);
  });
});

describe("scanFileForSecrets — server-only crypto in a client module", () => {
  it('flags @decocms/blocks/sdk/crypto imported in a "use client" file', () => {
    const src = `"use client";
import { resolveSecret } from "@decocms/blocks/sdk/crypto";
export function C() { return null; }`;
    const f = scanFileForSecrets("src/components/C.tsx", src);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("crypto_imported_in_client");
    expect(f[0].severity).toBe("error");
  });

  it("does NOT flag crypto imported from a server module", () => {
    const src = `import { resolveSecret } from "@decocms/blocks/sdk/crypto";
export function config() {}`;
    expect(scanFileForSecrets("src/setup.ts", src)).toHaveLength(0);
  });
});
