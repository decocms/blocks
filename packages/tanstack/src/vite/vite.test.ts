// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { decoTanstack, gitBuildHash, resolveBuildHash } from "./index.ts";

function configOf(plugins: Plugin[], command: "build" | "serve") {
  const plugin = plugins.find((p) => p.name === "decocms:tanstack");
  const hook = plugin?.config as (
    c: object,
    e: { command: string; mode: string },
  ) => {
    define: Record<string, string>;
    resolve: { dedupe: string[] };
  };
  return hook({}, { command, mode: command === "build" ? "production" : "development" });
}

describe("the build hash (D4: the commit, as v7)", () => {
  it("the CI's sha, shortened to 12", () => {
    expect(resolveBuildHash("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789ab");
  });

  it("without one, git's", () => {
    expect(resolveBuildHash(undefined)).toMatch(/^[0-9a-f]{12}$/);
    expect(resolveBuildHash("  ")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("without git, the time", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const hash = gitBuildHash(dir);
      expect(hash).not.toMatch(/^[0-9a-f]{12}$/);
      expect(Number.parseInt(hash, 36)).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decoTanstack defines __BUILD_HASH__: the sha on build, "dev" in vite dev', () => {
    const plugins = decoTanstack({ buildHash: "feedfacecafebeef" });
    expect(configOf(plugins, "build").define.__BUILD_HASH__).toBe('"feedfacecafe"');
    expect(configOf(plugins, "serve").define.__BUILD_HASH__).toBe('"dev"');
  });

  it("dedupes React, the TanStack packages and @decocms/blocks, and includes decoContent()", () => {
    const plugins = decoTanstack();
    expect(configOf(plugins, "build").resolve.dedupe).toEqual(
      expect.arrayContaining([
        "react",
        "react-dom",
        "@tanstack/react-router",
        "@tanstack/react-start",
        "@decocms/blocks",
      ]),
    );
    expect(plugins.map((p) => p.name)).toContain("decocms:content");
  });
});
