import fs from "node:fs";
import path from "node:path";
import { resolvePackageDirectory } from "./installedPackages";

/** Both the orchestrator and its child must parse the same invoke contract.
 * Resolve the package first so a local copy without invoke.ts cannot silently
 * pick up a different contract from a shadowed ancestor package. */
export function resolveInvokeSource(cwd: string, appsDir: string | null): string | null {
  const root = appsDir
    ? path.resolve(cwd, appsDir)
    : resolvePackageDirectory(cwd, "@decocms/apps-vtex");
  if (!root) return null;
  for (const dir of [root, path.join(root, "src")]) {
    const file = path.join(dir, "invoke.ts");
    if (fs.existsSync(file)) return file;
  }
  return null;
}
