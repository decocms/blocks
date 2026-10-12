/**
 * The protocol's browser-safe subpaths must bundle for a browser (and
 * Workers) target with no Node built-ins, and the filesystem storage must
 * resolve to its Node implementation only under the `node` condition.
 * Uses the esbuild CLI for the reason explained in cms/client.browserBundle.test.ts.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "../..");
const esbuildBin = join(here, "../../../../node_modules/.bin/esbuild");

function bundle(source: string, platform: "browser" | "node", conditions?: string) {
  const args = ["--bundle", `--platform=${platform}`, "--format=esm", "--log-level=error"];
  if (conditions) args.push(`--conditions=${conditions}`);
  return execFileSync(esbuildBin, args, {
    cwd: packageRoot,
    input: source,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const BROWSER_SAFE = [
  "@decocms/blocks/protocol",
  "@decocms/blocks/protocol/keys",
  "@decocms/blocks/protocol/server",
  "@decocms/blocks/protocol/conformance",
];

describe("protocol bundles", () => {
  it.each(BROWSER_SAFE)("%s bundles for a browser with no Node built-ins", (specifier) => {
    const output = bundle(`export * from "${specifier}";`, "browser");
    expect(output).not.toMatch(/from "node:|require\("node:/);
  });

  it("resolves storage/fs to a failing stub outside Node (browser and workerd conditions)", () => {
    const source = 'export { createFsStorage } from "@decocms/blocks/protocol/storage/fs";';
    for (const output of [bundle(source, "browser"), bundle(source, "browser", "workerd,worker")]) {
      expect(output).toContain("needs Node");
      expect(output).not.toMatch(/from "node:fs/);
    }
  });

  it("resolves storage/fs to the filesystem storage under the node condition", () => {
    const output = bundle(
      'export { createFsStorage } from "@decocms/blocks/protocol/storage/fs";',
      "node",
    );
    expect(output).toMatch(/node:fs\/promises/);
    expect(output).not.toContain("needs Node");
  });
});
