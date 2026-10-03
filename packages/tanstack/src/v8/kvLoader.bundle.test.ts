import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// The esbuild CLI, not its JS API: the API breaks across Vitest's realm
// boundary (see packages/blocks/src/cms/client.browserBundle.test.ts).
const esbuildBin = join(here, "../../../../node_modules/.bin/esbuild");

/**
 * The docs import `kvLoader` from the package root, which still re-exports
 * the v7 binding. `"sideEffects"` in package.json lets a bundler drop every
 * root module the site doesn't use; without it the Worker ships the v7
 * runtime (react-dom/server, Start server-core, OpenTelemetry...).
 */
describe("kvLoader bundle", () => {
  it("imports from the package root without pulling in the v7 binding", () => {
    const output = execFileSync(
      esbuildBin,
      [
        "--bundle",
        "--format=esm",
        "--platform=neutral",
        "--minify",
        "--main-fields=module,main",
        "--external:react",
        "--external:react-dom",
        "--external:@tanstack/*",
        "--external:node:*",
        "--log-level=error",
      ],
      {
        cwd: join(here, "../.."),
        input: 'export { kvLoader } from "@decocms/tanstack";',
        encoding: "utf-8",
      },
    );
    expect(output).toContain("kvLoader");
    expect(output.length).toBeLessThan(2048);
  });
});
