import { describe, expect, it, vi } from "vitest";
import type { MigrationContext } from "../types";

const npmView = vi.hoisted(() => vi.fn((_cmd: string) => "7.80.3\n"));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, default: { ...actual, execSync: npmView }, execSync: npmView };
});

const { generatePackageJson } = await import("./package-json");

const ctx = {
  siteName: "acme-store",
  platform: "vtex",
  importMap: {},
  discoveredNpmDeps: {},
} as unknown as MigrationContext;

describe("generatePackageJson — framework version", () => {
  // Since v8, @decocms/blocks' `latest` is 8.x, which the migrator's output
  // can't run on. blocks-cli only ships on the 7.x line, so its `latest` is
  // the newest 7.x of the lockstep set.
  it("reads the version from @decocms/blocks-cli, never @decocms/blocks' latest", () => {
    const pkg = JSON.parse(generatePackageJson(ctx));

    expect(npmView).toHaveBeenCalledTimes(1);
    expect(npmView.mock.calls[0][0]).toBe("npm view @decocms/blocks-cli version");
    for (const dep of [
      "@decocms/blocks",
      "@decocms/blocks-admin",
      "@decocms/tanstack",
      "@decocms/apps-vtex",
    ]) {
      expect(pkg.dependencies[dep], dep).toBe("^7.80.3");
    }
    expect(pkg.devDependencies["@decocms/blocks-cli"]).toBe("^7.80.3");
  });

  it("falls back to a 7.x version when npm can't be reached", () => {
    npmView.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    const pkg = JSON.parse(generatePackageJson(ctx));
    expect(pkg.dependencies["@decocms/blocks"]).toMatch(/^\^7\./);
  });
});
