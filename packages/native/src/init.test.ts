import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeInit } from "./init";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A site with generated artifacts and an Expo app nested inside it. */
function scaffold(appFiles: Record<string, string> = {}) {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "deco-native-init-"));
  roots.push(site);
  fs.mkdirSync(path.join(site, ".deco"), { recursive: true });
  fs.writeFileSync(path.join(site, ".deco/routes.gen.ts"), "export const cmsRoutes = [];");
  fs.writeFileSync(
    path.join(site, ".deco/invoke.native.gen.ts"),
    "export interface NativeHandlers {}",
  );

  const app = path.join(site, "app");
  fs.mkdirSync(app, { recursive: true });
  for (const [rel, contents] of Object.entries(appFiles)) {
    const full = path.join(app, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return { site, app };
}

describe("runNativeInit", () => {
  it("writes the three glue files", () => {
    const { app } = scaffold();
    const result = runNativeInit({ root: app });
    expect(result.created).toEqual(
      expect.arrayContaining(["metro.config.js", path.join("lib", "deco.ts"), "tsconfig.json"]),
    );
  });

  it("points the wiring import at the SITE root, not the app root", () => {
    // The bug this pins: `site` is relative to the app root, but the module is
    // written inside lib/ — one level deeper. Getting it wrong is silent until
    // Metro fails to resolve.
    const { site, app } = scaffold();
    runNativeInit({ root: app });
    const source = fs.readFileSync(path.join(app, "lib/deco.ts"), "utf8");
    const specifier = source.match(/from "([^"]*\.deco\/routes\.gen)"/)?.[1];
    expect(specifier).toBe("../../.deco/routes.gen");
    expect(fs.existsSync(path.resolve(app, "lib", `${specifier}.ts`))).toBe(true);
    expect(path.resolve(app, "lib", `${specifier}.ts`)).toBe(
      path.join(site, ".deco/routes.gen.ts"),
    );
  });

  it("keeps the specifier correct for a deeper lib dir", () => {
    const { app } = scaffold();
    runNativeInit({ root: app, libDir: "src/lib/deco" });
    const source = fs.readFileSync(path.join(app, "src/lib/deco/deco.ts"), "utf8");
    expect(source).toContain('"../../../../.deco/routes.gen"');
  });

  it("makes metro watch the site — without it, imports fail with the file in place", () => {
    const { app } = scaffold();
    runNativeInit({ root: app });
    const metro = fs.readFileSync(path.join(app, "metro.config.js"), "utf8");
    expect(metro).toContain("config.watchFolders = [siteRoot]");
    expect(metro).toContain("nodeModulesPaths");
  });

  it("never overwrites — safe to re-run", () => {
    const { app } = scaffold({ "metro.config.js": "// mine\n" });
    const result = runNativeInit({ root: app });
    expect(result.skipped).toContain("metro.config.js");
    expect(fs.readFileSync(path.join(app, "metro.config.js"), "utf8")).toBe("// mine\n");
  });

  it("tells the user what to add when metro.config.js already exists", () => {
    // Silence here would mean a broken build the tool could have explained.
    const { app } = scaffold({ "metro.config.js": "// mine\n" });
    expect(runNativeInit({ root: app }).next.join("\n")).toContain("watchFolders");
  });
});

describe("runNativeInit — tsconfig", () => {
  it("patches an existing tsconfig without losing its options", () => {
    const { app } = scaffold({
      "tsconfig.json": JSON.stringify({
        extends: "expo/tsconfig.base",
        compilerOptions: { strict: true, paths: { "~/*": ["./src/*"] } },
      }),
    });
    runNativeInit({ root: app });
    const parsed = JSON.parse(fs.readFileSync(path.join(app, "tsconfig.json"), "utf8"));
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.paths).toEqual({ "~/*": ["./src/*"] });
    // Without these, tsc reports node:async_hooks errors from inside
    // @decocms/blocks — the framework exports raw .ts, and skipLibCheck does
    // not cover .ts.
    expect(parsed.compilerOptions.types).toContain("node");
    expect(parsed.compilerOptions.skipLibCheck).toBe(true);
  });

  it("merges into an existing types array instead of replacing it", () => {
    const { app } = scaffold({
      "tsconfig.json": JSON.stringify({ compilerOptions: { types: ["jest"] } }),
    });
    runNativeInit({ root: app });
    const parsed = JSON.parse(fs.readFileSync(path.join(app, "tsconfig.json"), "utf8"));
    expect(parsed.compilerOptions.types.sort()).toEqual(["jest", "node"]);
  });

  it("leaves a JSONC tsconfig alone and explains what to add", () => {
    // Comments are valid and common in tsconfig; mangling one is worse than
    // asking.
    const { app } = scaffold({
      "tsconfig.json": '{\n  // keep me\n  "compilerOptions": {}\n}',
    });
    const result = runNativeInit({ root: app });
    expect(fs.readFileSync(path.join(app, "tsconfig.json"), "utf8")).toContain("// keep me");
    expect(result.next.join("\n")).toContain('"types": ["node"]');
  });

  it("reports it as unchanged when already configured", () => {
    const { app } = scaffold({
      "tsconfig.json": JSON.stringify({ compilerOptions: { types: ["node"], skipLibCheck: true } }),
    });
    expect(runNativeInit({ root: app }).skipped).toContain("tsconfig.json");
  });
});

describe("scaffolded screens", () => {
  it("writes a catch-all so the site opens on day one", () => {
    const { app } = scaffold();
    const result = runNativeInit({ root: app });
    expect(result.created).toContain(path.join("app", "[...path].tsx"));
    expect(result.created).toContain(path.join("app", "_layout.tsx"));
  });

  it("says out loud that the route table is a snapshot, not a whitelist", () => {
    // Narrowing the catch-all to only the generated routes breaks every page
    // published after the build until the next store release — which throws
    // away the point of a CMS-driven app.
    const { app } = scaffold();
    runNativeInit({ root: app });
    const source = fs.readFileSync(path.join(app, "app", "[...path].tsx"), "utf8");
    expect(source).toContain("SNAPSHOT");
    expect(source).toContain("not a whitelist");
  });

  it("lets the platform own the session instead of hand-rolling a jar", () => {
    // The scaffold must NOT wrap fetch in a cookie jar. On iOS/Android the OS
    // store is already shared with the WebView, and a jar there sends its own
    // `Cookie` header, which the server echoes back, which the native layer
    // stores — the value grows every round trip until the backend stops
    // recognising it and opens a fresh cart on every call.
    const { app } = scaffold();
    runNativeInit({ root: app });
    const source = fs.readFileSync(path.join(app, "lib", "deco.ts"), "utf8");
    expect(source).toContain("createNativeSession()");
    expect(source).toContain("jar: session.jar ?? false");
    expect(source).not.toContain("withCookieJar");
  });

  it("needs no native module for one shared session", () => {
    // @react-native-cookies/cookies was only ever a probe. Requiring it would
    // force a dev build on every consumer for something the OS does for free.
    const { app } = scaffold();
    runNativeInit({ root: app });
    const source = fs.readFileSync(path.join(app, "lib", "deco.ts"), "utf8");
    expect(source).not.toContain("@react-native-cookies/cookies");
  });

  it("does not overwrite screens the app already has", () => {
    const { app } = scaffold({ "app/_layout.tsx": "// mine" });
    const result = runNativeInit({ root: app });
    expect(result.skipped).toContain(path.join("app", "_layout.tsx"));
    expect(fs.readFileSync(path.join(app, "app", "_layout.tsx"), "utf8")).toBe("// mine");
  });
});

describe("metro config", () => {
  it("pins the packages that must be singletons", () => {
    // A linked framework checkout resolves react/react-native from ITS own
    // node_modules. Two copies of react-native means two native module
    // registries, and the app dies with "Maximum call stack size exceeded"
    // while evaluating the first import — with a perfectly successful bundle.
    const { app } = scaffold();
    runNativeInit({ root: app });
    const source = fs.readFileSync(path.join(app, "metro.config.js"), "utf8");
    expect(source).toContain("resolveRequest");
    for (const pkg of ["react", "react-native", "nativewind", "expo-router"]) {
      expect(source).toContain(`"${pkg}"`);
    }
  });
});
