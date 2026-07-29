/**
 * Cross-app guardrail: every commerce provider that makes upstream API calls
 * MUST route egress through the framework's `createInstrumentedFetch` and emit
 * the canonical `http.client.request.duration` histogram via
 * `recordCommerceMetric`. This is the contract that makes cache/upstream
 * telemetry AUTOMATIC — a new commerce app can't quietly ship egress that never
 * reaches ClickHouse.
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
