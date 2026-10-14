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

/** The v8 version every package of the release shares: blocks and both bindings. */
export const V8_RANGE = "^8.3.0";
