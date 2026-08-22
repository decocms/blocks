/**
 * `deco-native init` — wires an existing Expo app to a Deco site.
 *
 * It does **not** scaffold the app: `create-expo-app` does that better, and an
 * `init` that owns your app is an init you fight later. This only writes the
 * glue, and only what is not already there (idempotent).
 *
 * Every file it writes encodes a failure that is silent otherwise — all three
 * were found by actually consuming the package, not by reasoning about it:
 *
 * 1. **`metro.config.js`** — the app imports `<site>/.deco/routes.gen.ts`, but
 *    Metro only watches the project directory. Without `watchFolders` the
 *    import fails with "Unable to resolve module" *while the file is right
 *    there and `tsc` is happy*.
 * 2. **`tsconfig.json`** — the framework exports raw `.ts`, so a consumer's
 *    `tsc` type-checks its source, and `skipLibCheck` does not apply to `.ts`.
 *    Without `@types/node` the app reports `node:async_hooks` errors from
 *    inside `@decocms/blocks` — even though Metro correctly resolves the
 *    React Native stub.
 * 3. **`lib/deco.ts`** — one jar shared by `?renderJson` and `/deco/invoke`,
 *    because a cart cookie set by an invoke has to be on the next page load.
 */

import fs from "node:fs";
import path from "node:path";

export interface NativeInitOptions {
  /** Expo app root. Defaults to `process.cwd()`. */
  root?: string;
  /**
   * Path to the Deco site root, relative to the app. The generated artifacts
   * are read from `<site>/.deco/`.
   * @default ".."
   */
  site?: string;
  /** Where the wiring module goes, relative to the app root. @default "lib" */
  libDir?: string;
}

export interface NativeInitResult {
  created: string[];
  skipped: string[];
  /** Human-readable follow-ups the tool cannot do itself. */
  next: string[];
}

const METRO_CONFIG = (site: string) => `const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const siteRoot = path.resolve(__dirname, ${JSON.stringify(site)});

const config = getDefaultConfig(__dirname);

// The app imports the site's generated artifacts (<site>/.deco/routes.gen.ts,
// invoke.native.gen.ts). Metro watches only the project directory by default,
// so without this the import fails with "Unable to resolve module" — with the
// file in place and tsc satisfied.
config.watchFolders = [siteRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(siteRoot, "node_modules"),
];

// Local development only: when @decocms/* are symlinks to a framework checkout
// outside this repo, Metro will not follow them out of the watch. A normal npm
// dependency needs none of this.
for (const name of ["native", "blocks"]) {
  try {
    const real = fs.realpathSync(path.join(__dirname, "node_modules", "@decocms", name));
    if (!real.startsWith(siteRoot)) config.watchFolders.push(path.resolve(real, "../.."));
  } catch {
    // Not linked — nothing to do.
  }
}

module.exports = config;
`;

const DECO_WIRING = (siteFromLib: string) => `/**
 * Wiring for @decocms/native. The only place the app knows about the package.
 *
 * Everything here is configuration. If this file grows logic, that is a signal
 * the package is missing something — open an issue rather than working around
 * it here.
 */
import {
  cmsScreenConfig,
  createCookieJar,
  createNativeInvoke,
  createRenderJsonClient,
  createRoutePolicy,
  withCookieJar,
} from "@decocms/native";
import { cmsRoutes } from "${siteFromLib}/.deco/routes.gen";
import type { NativeHandlers } from "${siteFromLib}/.deco/invoke.native.gen";

/** The deployed worker that serves ?renderJson. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "http://localhost:5173";

/**
 * One jar for both surfaces: a cart cookie set by an invoke has to be on the
 * next ?renderJson. Pass \`storage\` (AsyncStorage/MMKV) to survive relaunches.
 */
export const jar = createCookieJar();

export const client = createRenderJsonClient({
  baseUrl: SITE_URL,
  fetcher: withCookieJar(jar),
});

export const { invoke } = createNativeInvoke<NativeHandlers>({ baseUrl: SITE_URL, jar });

/**
 * Per-route opt-in. \`cmsRoutes\` is generated from .deco/blocks — the same
 * files Studio writes — and is a SNAPSHOT, not a whitelist: anything absent
 * falls through to a WebView, including a page published after this build.
 */
export const routes = createRoutePolicy({
  routes: cmsRoutes,
  native: {
    // "/": "/(tabs)/home",
    // "/products/:slug": "/product/[slug]",
  },
});

export const pageConfig = (path?: string) => cmsScreenConfig({ client, path });
`;

/** Merges the keys the app needs into an existing tsconfig, preserving the rest. */
function patchTsconfig(file: string): "created" | "patched" | "unchanged" {
  const wanted = { types: ["node"], skipLibCheck: true };

  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `${JSON.stringify({ extends: "expo/tsconfig.base", compilerOptions: { strict: true, ...wanted } }, null, 2)}\n`,
    );
    return "created";
  }

  const raw = fs.readFileSync(file, "utf8");
  let parsed: { compilerOptions?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A tsconfig with comments is valid JSONC and common; leave it alone rather
    // than mangling it, and let the caller tell the user what to add.
    return "unchanged";
  }

  const options = parsed.compilerOptions ?? {};
  const already =
    Array.isArray(options.types) && options.types.includes("node") && options.skipLibCheck === true;
  if (already) return "unchanged";

  parsed.compilerOptions = {
    ...options,
    ...wanted,
    types: [...new Set([...((options.types as string[]) ?? []), "node"])],
  };
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return "patched";
}

export function runNativeInit(options: NativeInitOptions = {}): NativeInitResult {
  const root = path.resolve(options.root ?? process.cwd());
  const site = options.site ?? "..";
  const libDir = options.libDir ?? "lib";

  const created: string[] = [];
  const skipped: string[] = [];
  const next: string[] = [];

  const write = (relative: string, contents: string) => {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) {
      skipped.push(relative);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    created.push(relative);
  };

  write("metro.config.js", METRO_CONFIG(site));

  // `site` is relative to the app root, but the wiring module lives inside
  // `libDir` — one or more levels deeper. Writing the app-root-relative
  // specifier there resolves to the wrong place (silently, until Metro fails).
  const libToSite = path
    .relative(path.join(root, libDir), path.resolve(root, site))
    .replace(/\\/g, "/");
  write(path.join(libDir, "deco.ts"), DECO_WIRING(libToSite || "."));

  const tsconfig = patchTsconfig(path.join(root, "tsconfig.json"));
  if (tsconfig === "created") created.push("tsconfig.json");
  else if (tsconfig === "patched") created.push("tsconfig.json (patched)");
  else skipped.push("tsconfig.json");

  if (tsconfig === "unchanged" && fs.existsSync(path.join(root, "tsconfig.json"))) {
    next.push(
      'tsconfig.json: add `"types": ["node"]` and `"skipLibCheck": true` — without them ' +
        "tsc reports node:async_hooks errors from inside @decocms/blocks, because the " +
        "framework exports raw .ts and skipLibCheck does not cover it.",
    );
  }
  if (skipped.includes("metro.config.js")) {
    next.push(
      "metro.config.js already exists: add `config.watchFolders = [siteRoot]` — Metro " +
        "watches only the project dir, so importing <site>/.deco/* fails with " +
        '"Unable to resolve module" even though the file is there.',
    );
  }

  next.push(
    `In the site, run: npx @decocms/blocks-cli/generate --platform native  ` +
      `(emits .deco/routes.gen.ts and .deco/invoke.native.gen.ts)`,
  );
  next.push(`Set EXPO_PUBLIC_SITE_URL, or edit SITE_URL in ${libDir}/deco.ts.`);
  next.push(`Opt pages into native screens in the \`native\` map of ${libDir}/deco.ts.`);

  return { created, skipped, next };
}
