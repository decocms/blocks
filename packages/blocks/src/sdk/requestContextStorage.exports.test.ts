import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the CONDITION ORDER of the `./sdk/requestContextStorage` exports map.
 *
 * The map picks between an `AsyncLocalStorage`-backed implementation and a
 * no-op stub. Getting it wrong is silent in both directions: a bundle that
 * wrongly gets the real module fails on `node:async_hooks`; a runtime that
 * wrongly gets the stub loses cookies, abort signals and device detection with
 * **no build error at all**.
 *
 * Two facts make this untestable by inspection, which is why this file exists:
 *
 * 1. Condition matching is *first match in insertion order* (Node's
 *    PACKAGE_TARGET_RESOLVE), so reordering keys silently changes behavior.
 * 2. Cloudflare Workers activate `browser` **alongside** `workerd`. If
 *    `browser` were listed first, a real production deploy would get the no-op
 *    stub. That is the footgun documented in CLAUDE.md.
 *
 * `node --conditions=...` cannot check this: Node always activates `node`
 * itself and `--conditions` only *adds* to the defaults, so every probe
 * resolves to the real module regardless of the map. Hence the clean-room
 * resolver below.
 */

// Read from cwd, not `import.meta.url`: the jsdom environment this suite runs
// in does not give `import.meta.url` a `file:` scheme. Vitest's root is the
// monorepo root (see vitest.config.ts, and each package's
// `vitest run --root ../..` test script), so this path is stable.
const pkg = JSON.parse(readFileSync("packages/blocks/package.json", "utf8")) as {
  exports: Record<string, unknown>;
};

const target = pkg.exports["./sdk/requestContextStorage"];

/** Minimal PACKAGE_TARGET_RESOLVE: first key whose condition is active wins. */
function resolveTarget(t: unknown, conditions: Set<string>): string | null {
  if (typeof t === "string") return t;
  if (!t || typeof t !== "object") return null;
  for (const [key, value] of Object.entries(t as Record<string, unknown>)) {
    if (key === "default" || conditions.has(key)) return resolveTarget(value, conditions);
  }
  return null;
}

const backendFor = (conditions: string[]): "real" | "stub" => {
  const resolved = resolveTarget(target, new Set(conditions));
  expect(resolved, `no export matched ${conditions.join(",")}`).toBeTruthy();
  return resolved!.endsWith(".browser.ts") ? "stub" : "real";
};

describe("requestContextStorage exports map — condition order", () => {
  // Real backend: runtimes that have node:async_hooks AND serve requests.
  it.each([
    // The load-bearing case: `browser` is active here too. If it were listed
    // before `workerd`, production Workers would silently get the no-op stub.
    ["Cloudflare Workers", ["workerd", "worker", "browser", "import", "default"]],
    ["Node SSR", ["node", "import", "default"]],
    ["no conditions at all (default)", ["import", "default"]],
  ])("%s gets the real AsyncLocalStorage backend", (_name, conditions) => {
    expect(backendFor(conditions)).toBe("real");
  });

  // Stub: bundles with no per-request async context.
  it.each([
    // Metro's unstable_conditionsByPlatform: ios/android/tvos/macos.
    ["Metro (React Native)", ["react-native", "import", "require", "default"]],
    // Metro's web platform, and Vite/webpack client builds.
    ["Metro web / Expo web", ["browser", "import", "require", "default"]],
    ["Vite client build", ["browser", "import", "default"]],
    // Some bundlers activate both; either key resolves to the stub, so order
    // between them is not load-bearing — but assert it so a future edit that
    // points one of them at the real module fails here.
    ["bundler activating react-native + browser", ["react-native", "browser", "import", "default"]],
  ])("%s gets the no-op stub", (_name, conditions) => {
    expect(backendFor(conditions)).toBe("stub");
  });

  it("lists workerd and node before browser", () => {
    const keys = Object.keys(target as Record<string, unknown>);
    expect(keys.indexOf("workerd")).toBeLessThan(keys.indexOf("browser"));
    expect(keys.indexOf("node")).toBeLessThan(keys.indexOf("browser"));
  });

  it("ends with a default so no runtime resolves to nothing", () => {
    const keys = Object.keys(target as Record<string, unknown>);
    expect(keys.at(-1)).toBe("default");
  });
});
