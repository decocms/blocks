/**
 * `deco-native init` — wires an existing Expo app to a Deco site.
 *
 * It does **not** scaffold the Expo app: `create-expo-app` does that better, and
 * an `init` that owns your app is an init you fight later. It writes the glue
 * and the screens that make the glue visible, and only what is not already
 * there (idempotent).
 *
 * The screens matter as much as the wiring. Route policy alone classifies a
 * destination as `webview`, but nothing renders one — so an app with the
 * package installed and no screens opens to a blank scaffold, which reads as
 * "the package does not work". The catch-all below is what makes the site
 * usable on day one, including pages published after the binary shipped.
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

/**
 * Packages that must exist exactly ONCE in the bundle.
 *
 * A module is resolved from where it lives. So when \`@decocms/native\` is a
 * symlink to a framework checkout, it picks up the \`react\`/\`react-native\`
 * from THAT repo's node_modules. Two copies of react-native means two native
 * module registries, and the app dies with "Maximum call stack size exceeded
 * (native stack depth)" while evaluating the first import — with no bundling
 * error at all, because bundling both is perfectly possible.
 *
 * Seen in practice as react-native 0.81.5 against 0.81.6, react 19.1.0 against
 * 19.2.7. A plain npm dependency does not hit this; a linked checkout always
 * does.
 */
const SINGLETONS = [
  "react",
  "react-dom",
  "react-native",
  "react-native-css",
  "nativewind",
  "react-native-webview",
  "react-native-safe-area-context",
  "react-native-screens",
  "expo-router",
  "@tanstack/react-query",
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pkg = moduleName.startsWith("@")
    ? moduleName.split("/").slice(0, 2).join("/")
    : moduleName.split("/")[0];

  if (SINGLETONS.includes(pkg)) {
    // Resolve as if the import came from the app root, not from wherever the
    // importing module happens to live.
    return context.resolveRequest(
      { ...context, originModulePath: path.join(__dirname, "index.js") },
      moduleName,
      platform,
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

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
  createNativeInvoke,
  createNativeSession,
  createRenderJsonClient,
  createRoutePolicy,
} from "@decocms/native";
import { cmsRoutes } from "${siteFromLib}/.deco/routes.gen";
import type { NativeHandlers } from "${siteFromLib}/.deco/invoke.native.gen";

/** The deployed worker that serves ?renderJson. */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "http://localhost:5173";

/**
 * How this app carries its session.
 *
 * On iOS/Android the OS already persists cookies AND shares them with a
 * WebView, so native screens and embedded pages are one session for free —
 * an item added on a page inside the WebView is in the cart a native screen
 * reads. Adding a jar there does not duplicate the platform, it CORRUPTS the
 * session: see the comment in \`@decocms/native/src/session.ts\`.
 *
 * Elsewhere (Expo web) the jar is what makes a cart exist at all.
 */
export const session = createNativeSession();

export const client = createRenderJsonClient({
  baseUrl: SITE_URL,
  fetcher: session.fetcher,
});

// \`false\` means "the platform owns the cookie" — see \`session\` above.
export const { invoke } = createNativeInvoke<NativeHandlers>({
  baseUrl: SITE_URL,
  jar: session.jar ?? false,
});

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

const ROOT_LAYOUT = `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }} />
    </QueryClientProvider>
  );
}
`;

const CATCH_ALL = (libDir: string) => `import { SiteView } from "@decocms/native";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { WebView } from "react-native-webview";
import { SITE_URL, routes } from "${libDir}/deco";

/**
 * Every page with no native screen — which on day one is every page.
 *
 * This is a catch-all on purpose, and it must stay one. \`cmsRoutes\` is a
 * SNAPSHOT taken at build time, not a whitelist: a page published in Studio
 * after this binary shipped has to open too, and it does, here. Treating the
 * generated table as a whitelist would break new pages until the next store
 * release, which throws away the point of a CMS-driven app.
 *
 * To promote a route to native, add a line to the \`native\` map in
 * \`${libDir}/deco.ts\` and write the screen. Nothing here changes.
 */
export default function SiteRoute() {
  const router = useRouter();
  const qc = useQueryClient();
  const { path } = useLocalSearchParams<{ path?: string[] }>();

  return (
    <SiteView
      WebViewComponent={WebView}
      baseUrl={SITE_URL}
      path={\`/\${(path ?? []).join("/")}\`}
      resolve={routes.resolve}
      onNavigateNative={(route) => router.push(route as never)}
      // A page inside the WebView changed shared state. Native has no way to
      // know otherwise — no event fires, and the query only revalidates when
      // its staleTime expires, so a cart badge would sit still.
      onMutation={() => void qc.invalidateQueries({ queryKey: ["cart"] })}
      onLog={(level, text) => console.log(\`[webview:\${level}]\`, text)}
    />
  );
}
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

  // The screens. Without them the package is installed and the app opens to
  // nothing — which reads as "it does not work" rather than "no screens yet".
  write(path.join("app", "_layout.tsx"), ROOT_LAYOUT);
  write(path.join("app", "[...path].tsx"), CATCH_ALL(libToSite === "." ? `./${libDir}` : `../${libDir}`));

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
  next.push(
    "Install the peers the scaffolded screens use: " +
      "npx expo install react-native-webview @tanstack/react-query",
  );
  next.push(
    'Using @decocms/native/daisy? Add `@import "@decocms/native/daisy.css";` to the Tailwind ' +
      "entry. The JIT only emits classes it SEES and does not look in node_modules, so " +
      "`bg-primary` inside a packaged <Button> would simply not exist in the CSS — an uncoloured " +
      "button, a transparent modal, and no error anywhere. It has to be that import rather than " +
      "an `@source` pointing at node_modules: in a linked checkout that path is a symlink, and " +
      "Tailwind does not walk symlinked directories.",
  );
  next.push(
    "For one session across native and WebView: npx expo install @react-native-cookies/cookies. " +
      "It is a NATIVE module, so it needs a dev build — Expo Go cannot load it, and without it " +
      "an item added inside the WebView lands in a different cart from the native screens.",
  );
  next.push(
    "Images: render them with `DecoImage` from @decocms/native/image, and register a backend " +
      "once at boot (`setImageBackend({ Image, prefetch })` with expo-image). Without the " +
      "backend it still works, minus disk cache and prefetch. Without DecoImage the app " +
      "downloads CMS originals — measured at 1.34 MB per product photo for a 160dp card, and " +
      "1.62 MB for a home banner, against 79 KB and 15 KB resized.",
  );
  next.push(`Set EXPO_PUBLIC_SITE_URL, or edit SITE_URL in ${libDir}/deco.ts.`);
  next.push(`Opt pages into native screens in the \`native\` map of ${libDir}/deco.ts.`);

  return { created, skipped, next };
}
