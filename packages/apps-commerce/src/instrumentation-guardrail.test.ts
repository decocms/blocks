/**
 * Cross-app guardrail: every commerce provider that makes upstream API calls
 * MUST ship an instrumented fetch that routes egress through the framework's
 * `createInstrumentedFetch` and emits the canonical
 * `http.client.request.duration` histogram via `recordCommerceMetric`.
 *
 * Scope, stated honestly: this asserts the *factory exists* in the package
 * (it greps `src/utils/instrumentedFetch.ts` for the two required symbols). It
 * does NOT prove the fetch is actually reached at runtime — for VTEX/Shopify/
 * Magento that still depends on the *site* calling `setXFetch(createXFetch())`
 * at boot (they fall back to an uninstrumented `globalThis.fetch` otherwise).
 * Only Salesforce is auto-wired via `createHttpClient`'s default fetcher. So
 * this catches "a provider shipped with no instrumented fetch at all"; it does
 * not catch "a site forgot to wire it".
 *
 * This test reads sibling package source from disk (it does NOT import app
 * modules) so it stays within the one-way dependency graph. If you add a new
 * commerce provider, add it to REQUIRED below and give it a
 * `src/utils/instrumentedFetch.ts` that wires the two symbols.
 *
 * Known exception: `apps-algolia` uses the `algoliasearch` SDK, which owns its
 * own transport + cache, so it has no framework-instrumented fetch and is not
 * listed here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Repo root = nearest ancestor of cwd that contains `packages/apps-commerce`.
// Robust whether the runner's cwd is the repo root (vitest --root .) or the
// package dir (`bun run --filter ... test`).
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "apps-commerce"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (packages/apps-commerce not found above cwd)");
}
const repoRoot = findRepoRoot();

/** Commerce apps whose upstream egress must be instrumented. */
const REQUIRED = ["apps-vtex", "apps-shopify", "apps-magento", "apps-salesforce"] as const;

describe("commerce apps instrumentation guardrail", () => {
  for (const app of REQUIRED) {
    it(`${app} wires createInstrumentedFetch + recordCommerceMetric`, () => {
      const file = join(repoRoot, "packages", app, "src", "utils", "instrumentedFetch.ts");
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        throw new Error(
          `${app} is missing src/utils/instrumentedFetch.ts — every commerce app must ` +
            `route egress through @decocms/blocks/sdk/instrumentedFetch. See apps-vtex for the pattern.`,
        );
      }
      expect(src, `${app} must call createInstrumentedFetch`).toContain("createInstrumentedFetch");
      expect(src, `${app} must record the commerce histogram`).toContain("recordCommerceMetric");
    });
  }
});

/**
 * v8 thin clients (/next/upstream-clients): each client module creates its
 * requests with `createInstrumentedFetch` from `@decocms/blocks/fetch` under
 * its own provider name, and never calls a fetch around it. Unlike the v7
 * factories above, nothing has to be wired at boot: the instrumented fetch is
 * the only way the client reaches the network. Each client's own tests assert
 * the operation labels.
 */
const V8_CLIENTS: Record<string, { file: string; provider: string }> = {
  "apps-shopify": { file: "src/v8/client.ts", provider: "shopify" },
  "apps-vtex": { file: "src/vtexClient.ts", provider: "vtex" },
  "apps-wake": { file: "src/wakeClient.ts", provider: "wake" },
  "apps-magento": { file: "src/magentoClient.ts", provider: "magento" },
};

describe("v8 upstream clients use the instrumented fetch", () => {
  for (const [app, { file, provider }] of Object.entries(V8_CLIENTS)) {
    it(`${app} sends every request through createInstrumentedFetch as "${provider}"`, () => {
      const src = readFileSync(join(repoRoot, "packages", app, file), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src).toMatch(
        /import\s*\{[^}]*\bcreateInstrumentedFetch\b[^}]*\}\s*from\s*"@decocms\/blocks\/fetch"/,
      );
      expect(src).toMatch(
        new RegExp(`createInstrumentedFetch\\(\\s*\\{[^}]*\\bprovider:\\s*"${provider}"`),
      );
      expect(code, `${app} must not call fetch directly`).not.toMatch(/(^|[^.\w])fetch\s*\(/m);
      expect(code).not.toContain("globalThis.fetch");
    });
  }
});
