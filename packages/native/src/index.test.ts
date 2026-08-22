import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The root barrel must stay importable from a React Native bundle.
 *
 * This is not theoretical: adding push evaluation to it broke every native
 * bundle with "Unable to resolve module node:async_hooks", because the push
 * module reaches into the CMS matcher engine (server-only). The failure showed
 * up in `expo export`, not in tsc or vitest — so a source-level guard is the
 * only thing that catches it before someone else hits it.
 */
describe("index barrel — device safety", () => {
  const source = readFileSync("packages/native/src/index.ts", "utf8");

  it("does not re-export the server-only push module", () => {
    expect(source).not.toMatch(/from "\.\/push"/);
  });

  it("only re-exports modules that a phone can load", () => {
    const modules = [...source.matchAll(/from "\.\/([\w.]+)"/g)].map((m) => m[1]);
    // `setup` is exported as a subpath too, but is device-safe either way.
    expect(new Set(modules)).toEqual(
      new Set([
        "DecoSections",
        "cmsScreenConfig",
        "cookies",
        "invoke",
        "renderJson",
        "routes",
        "setup",
      ]),
    );
  });
});
