/**
 * Builds @decocms/blocks's dist/ once before the suite. The `deco` bin runs
 * dist/ (bin/deco.js), and the CLI conformance tests spawn it and run temp
 * apps that import the package the way an installed app does, so they must see
 * the current sources compiled, not a dist/ left over from an earlier build.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(
    process.execPath,
    [path.join(repo, "scripts/tsc.mjs"), "--clean", "dist", "-p", "tsconfig.build.json"],
    { cwd: path.join(repo, "packages/blocks"), stdio: "inherit" },
  );
}
