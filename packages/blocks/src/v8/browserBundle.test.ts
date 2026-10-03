// @vitest-environment node
/**
 * The v8 core must run anywhere: Node, Cloudflare Workers, Deno, Bun and a
 * browser. A real esbuild bundle (not just tsc) is the only reliable way to
 * catch a Node built-in sneaking into the graph, so bundle it for a browser
 * and for a workerd-style target and check the output.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// Shell out to the esbuild binary: its JS API trips over Vitest's realm isolation.
const esbuildBin = join(here, "../../../../node_modules/.bin/esbuild");

function bundle(args: string[], entry = "index.ts"): string {
  return execFileSync(esbuildBin, [join(here, entry), "--bundle", "--format=esm", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("v8 core bundle", () => {
  it("bundles for a browser target with no Node built-ins", () => {
    const output = bundle(["--platform=browser"]);
    expect(output).not.toMatch(/node:|require\(/);
    expect(output).toContain("createCMS");
  });

  it("bundles for a workerd target (neutral platform, Workers conditions) with no Node built-ins", () => {
    const output = bundle(["--platform=neutral", "--conditions=workerd,worker,browser"]);
    expect(output).not.toMatch(/node:|require\(/);
  });

  it("imports nothing at runtime but its own modules, the ciphertext format and the shared content hash (no React, no v7 code)", () => {
    const output = bundle([
      "--platform=neutral",
      "--metafile=/dev/stdout",
      "--outfile=/dev/null",
      "--log-level=error",
    ]);
    const inputs = Object.keys(JSON.parse(output.slice(output.indexOf("{"))).inputs);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input, input).toMatch(/(^|\/)src\/(v8\/|protocol\/(canonical|ciphertext)\.ts$)/);
    }
  });
});
