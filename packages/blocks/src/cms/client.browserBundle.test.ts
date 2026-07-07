import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// esbuild's JS API relies on `new TextEncoder().encode("") instanceof
// Uint8Array` internally, which fails across Vitest's module-isolation VM
// boundary (a realm mismatch, not a real environment problem — `bun -e`
// confirms the invariant holds outside Vitest). Shelling out to the esbuild
// CLI binary sidesteps this: it's a separate OS process, no shared JS realm.
const esbuildBin = join(here, "../../../../node_modules/.bin/esbuild");

function bundleForBrowser(entry: string) {
  return execFileSync(
    esbuildBin,
    [entry, "--bundle", "--platform=browser", "--format=esm", "--external:react"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * Regression test for the bug that motivated splitting `client.ts` out of
 * `index.ts`: importing ANYTHING from the full `cms` barrel forces a
 * bundler to evaluate `loader.ts` and `middleware/observability.ts`, which
 * import `node:async_hooks` at the module level. Turbopack rejects that
 * outright when bundling for a browser target; this test catches the same
 * class of failure in CI, deterministically, without needing a real Next.js
 * app to reproduce it.
 */
describe("cms/client browser bundle", () => {
  it("bundles for a browser target with no Node built-ins", () => {
    const output = bundleForBrowser(join(here, "client.ts"));
    expect(output).not.toMatch(/node:async_hooks|node:fs|node:path/);
  });

  it("sanity check: the full cms barrel does NOT bundle for a browser target", () => {
    // Confirms the test above is actually discriminating — if this ever
    // stops throwing, either the barrel no longer has the leak (great,
    // update this test) or esbuild's Node-builtin detection changed
    // (investigate before trusting the test above).
    expect(() => bundleForBrowser(join(here, "index.ts"))).toThrow();
  });
});
