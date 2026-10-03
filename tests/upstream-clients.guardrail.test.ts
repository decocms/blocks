// @vitest-environment node
/**
 * Guardrail: every upstream client (/next/upstream-clients) creates its
 * requests with `createInstrumentedFetch` from `@decocms/blocks/fetch` under
 * its own provider name, and never calls a fetch around it. Nothing has to be
 * wired at boot: the instrumented fetch is the only way a client reaches the
 * network, so every request is measured. Each client's own tests assert the
 * operation labels.
 *
 * It reads package source from disk (it does not import the clients). A new
 * client package goes in CLIENTS.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Repo root = nearest ancestor of cwd that contains `packages/blocks`.
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "blocks"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (packages/blocks not found above cwd)");
}
const repoRoot = findRepoRoot();

const CLIENTS: Record<string, { file: string; provider: string }> = {
  "apps-shopify": { file: "src/client.ts", provider: "shopify" },
  "apps-vtex": { file: "src/vtexClient.ts", provider: "vtex" },
  "apps-wake": { file: "src/wakeClient.ts", provider: "wake" },
  "apps-magento": { file: "src/magentoClient.ts", provider: "magento" },
  "apps-algolia": { file: "src/index.ts", provider: "algolia" },
  "apps-resend": { file: "src/emails.ts", provider: "resend" },
  "apps-sfmc-personalization": { file: "src/index.ts", provider: "sfmc-personalization" },
};

describe("upstream clients use the instrumented fetch", () => {
  it("every packages/apps-* client is listed here", () => {
    const apps = readdirSync(join(repoRoot, "packages")).filter((dir) => dir.startsWith("apps-"));
    expect(apps.sort()).toEqual(Object.keys(CLIENTS).sort());
  });

  for (const [app, { file, provider }] of Object.entries(CLIENTS)) {
    it(`${app} sends every request through createInstrumentedFetch as "${provider}"`, () => {
      const src = readFileSync(join(repoRoot, "packages", app, file), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src).toMatch(
        /import\s*\{[^}]*\bcreateInstrumentedFetch\b[^}]*\}\s*from\s*"@decocms\/blocks\/fetch"/,
      );
      expect(src).toMatch(
        new RegExp(`createInstrumentedFetch\\(\\s*\\{[^}]*\\bprovider:\\s*"${provider}"`),
      );
      expect(code, `${app} must not call fetch directly`).not.toMatch(/\bfetch\s*\(/);
    });
  }
});
