/** Which v7 framework binding the site ran on, from its `package.json`. */
import fs from "node:fs";
import path from "node:path";
import { isPlainObject } from "./walk";

export type Framework = "tanstack" | "nextjs";

/**
 * `"tanstack"` when the site depends on `@decocms/tanstack`, `"nextjs"` on
 * `@decocms/nextjs`, else `undefined` (a native app, a FastStore store that
 * isn't ejected). Each moves to the binding of the same name in v8.
 */
export function siteFramework(root: string): Framework | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const has = (name: string) =>
      ["dependencies", "devDependencies"].some(
        (field) => isPlainObject(pkg[field]) && Object.hasOwn(pkg[field], name),
      );
    if (has("@decocms/tanstack")) return "tanstack";
    if (has("@decocms/nextjs")) return "nextjs";
  } catch {
    // No readable package.json: no binding.
  }
  return undefined;
}

/**
 * The `@decocms/blocks` 7.x version the site ran: the installed copy's, else
 * the lowest version its `package.json` range names; `undefined` when neither
 * is a 7.x version. v7's image URLs changed across 7.x releases.
 */
export function siteBlocksVersion(root: string): string | undefined {
  const v7 = (v: unknown) =>
    typeof v === "string" ? /(?:^|[^\d.])(7\.\d+\.\d+)/.exec(v)?.[1] : undefined;
  try {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(root, "node_modules", "@decocms", "blocks", "package.json"),
        "utf8",
      ),
    );
    const version = v7(installed.version);
    if (version) return version;
  } catch {
    // Not installed: the range in package.json.
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies"]) {
      const version = isPlainObject(pkg[field]) ? v7(pkg[field]["@decocms/blocks"]) : undefined;
      if (version) return version;
    }
  } catch {
    // No readable package.json.
  }
  return undefined;
}

/** The v8 version every package of the release shares: blocks and both bindings. */
export const V8_RANGE = "^8.3.0";
