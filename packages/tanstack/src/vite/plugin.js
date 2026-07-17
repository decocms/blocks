/**
 * Deco Vite plugin — server-only stubs for TanStack Start storefronts.
 *
 * Replaces server-only modules with lightweight client stubs so they
 * are eliminated from the browser bundle. This consolidates stubs that
 * every Deco site previously had to copy into its own vite.config.ts.
 *
 * blocks.gen.ts handling:
 *   The CMS block registry can be 10MB+. Inlining it as a JS object literal
 *   causes Vite's SSR module runner to hang on dynamic imports (transport
 *   serialization bottleneck) and is slow to parse even with static imports
 *   (V8 full JS parser). Instead, generate-blocks.ts writes a .json data
 *   file, and this plugin intercepts the .ts import to return JSON.parse(...)
 *   — V8's JSON parser is 2-10x faster than the JS parser for large data.
 *
 * meta.gen handling:
 *   The admin schema bundle (`.deco/meta.gen.json`) is server-only;
 *   the client receives pre-resolved blocks via the SSR payload. Stubbing
 *   it on the client cuts a typically-large module out of the browser bundle.
 *   Match is done by substring on the import id, so any path style works.
 *
 * manualChunks:
 *   `@decocms/tanstack` and `@decocms/apps` are intentionally NOT split
 *   into their own chunks. They have circular re-exports that produce a
 *   load-order crash when chunked separately. Rollup's default bundling
 *   (group with importer or vendor catch-all) avoids that.
 *
 * Usage:
 * ```ts
 * import { decoVitePlugin } from "@decocms/tanstack/vite";
 * export default defineConfig({ plugins: [decoVitePlugin(), ...] });
 * ```
 */
import { exec, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a per-build identifier for cache-key versioning.
 *
 * The returned string is injected into the worker bundle as the
 * `__DECO_BUILD_HASH__` global via Vite `define`. `createDecoWorkerEntry`
 * appends it (or `env.BUILD_HASH` if explicitly set) as `__v=<hash>` on
 * every Cache API key, so each new deploy gets its own cache namespace
 * — old edge-cached HTML referencing dead asset filenames stops being
 * served the moment the new worker is live.
 *
 * Resolution order:
 *   1. WORKERS_CI_COMMIT_SHA — Cloudflare Workers Builds default env var
 *      (the production deploy path-of-record). Sliced to 12 chars.
 *   2. `git rev-parse --short=12 HEAD` — local `wrangler deploy` from a
 *      developer laptop. Try/catch so missing git or shallow clones don't
 *      fail the build.
 *   3. `Date.now().toString(36)` — last-resort fallback so the cache-bust
 *      invariant never silently regresses to "always the same key".
 *
 * For dev (`command !== "build"`), the value is the literal `"dev"`.
 *
 * @returns {string}
 */
function resolveBuildHash() {
  const ciSha = process.env.WORKERS_CI_COMMIT_SHA;
  if (ciSha?.trim()) return ciSha.trim().slice(0, 12);

  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    // git absent, not a repo, or shallow clone w/o history — fall through.
  }

  return Date.now().toString(36);
}

// Bare-specifier stubs resolved by ID before Vite touches them.
/** @type {Record<string, string>} */
const CLIENT_STUBS = {
  "react-dom/server": "\0stub:react-dom-server",
  "react-dom/server.browser": "\0stub:react-dom-server",
  "node:stream": "\0stub:node-stream",
  "node:stream/web": "\0stub:node-stream-web",
  "node:async_hooks": "\0stub:node-async-hooks",
  "tanstack-start-injected-head-scripts:v": "\0stub:tanstack-head-scripts",
};

// SSR-only stubs. Same mechanism as CLIENT_STUBS but applied to the worker
// SSR build instead of the browser build.
/** @type {Record<string, string>} */
const SSR_STUBS = {
  // `@opentelemetry/resources` (transitively pulled in by sdk-logs /
  // sdk-metrics / exporter-* OTel packages — five copies in node_modules due
  // to OTel monorepo peer-dep version pinning) statically imports bare `fs`
  // inside its node-platform machine-id detectors. We never call those
  // detectors — `instrumentWorker` builds the OTel Resource from explicit
  // attributes only — but Vite's CF Workers SSR resolver still walks the
  // re-export barrel and chokes on the bare `fs` specifier (workerd's
  // `nodejs_compat` only exposes the prefixed `node:fs`, not the legacy
  // bare form). Stub it; the static import resolves and the unreachable
  // detector code is never executed.
  fs: "\0stub:bare-fs",
};

// Minimal stub source for each virtual module.
/** @type {Record<string, string>} */
const STUB_SOURCE = {
  "\0stub:react-dom-server": [
    "const noop = () => '';",
    "export const renderToString = noop;",
    "export const renderToStaticMarkup = noop;",
    "export const renderToReadableStream = noop;",
    "export const resume = noop;",
    "export const version = '19.0.0';",
    "export default { renderToString: noop, renderToStaticMarkup: noop, renderToReadableStream: noop, resume: noop, version: '19.0.0' };",
  ].join("\n"),

  "\0stub:node-stream":
    "export class PassThrough {}; export class Readable {}; export class Writable {}; export default { PassThrough, Readable, Writable };",

  "\0stub:node-stream-web":
    "export const ReadableStream = globalThis.ReadableStream; export const WritableStream = globalThis.WritableStream; export const TransformStream = globalThis.TransformStream; export default { ReadableStream, WritableStream, TransformStream };",

  "\0stub:node-async-hooks": [
    "class _ALS { getStore() { return undefined; } run(_store, fn, ...args) { return fn(...args); } enterWith() {} disable() {} }",
    "export const AsyncLocalStorage = _ALS;",
    "export const AsyncResource = class {};",
    "export function executionAsyncId() { return 0; }",
    "export function createHook() { return { enable() {}, disable() {} }; }",
    "export default { AsyncLocalStorage: _ALS, AsyncResource, executionAsyncId, createHook };",
  ].join("\n"),

  "\0stub:tanstack-head-scripts": "export const injectedHeadScripts = undefined;",

  // The admin schema bundle is server-only — the client receives pre-resolved
  // blocks via the SSR payload. Stubbing it on the client cuts a large module
  // (typically 0.5-5 MB) out of the browser bundle.
  "\0stub:meta-gen": "export default {};",

  // Bare `fs` shim — see SSR_STUBS comment above for the rationale. Surfaces
  // just enough of `import { promises as fs } from 'fs'` to satisfy static
  // module resolution; method calls would throw, but the OTel detector code
  // path is unreachable from `instrumentWorker`.
  "\0stub:bare-fs": "export const promises = {}; export default { promises };",
};

/** @returns {import("vite").PluginOption} */
export function decoVitePlugin() {
  /** @type {import("vite").Plugin} */
  const plugin = {
    name: "deco-server-only-stubs",
    enforce: "pre",

    resolveId(id, importer, options) {
      // SSR-only stubs — must be checked first since the client guard below
      // returns undefined for everything that hasn't matched yet on SSR.
      if (options?.ssr && SSR_STUBS[id]) return SSR_STUBS[id];
      // Server builds keep the real modules.
      if (options?.ssr) return undefined;
      // Bare-specifier exact-match stubs (react-dom/server, node:stream, etc.).
      if (CLIENT_STUBS[id]) return CLIENT_STUBS[id];
      // meta.gen.{json,ts} — the admin schema bundle. Server-only; client
      // receives pre-resolved blocks. Matches both file extensions so the
      // plugin works whether `setup.ts` imports the .json directly (current)
      // or a future variant routes through a generated .ts wrapper.
      // Requires `importer` so we don't accidentally stub the entry module.
      if (importer && (id.endsWith("meta.gen.json") || id.endsWith("meta.gen.ts"))) {
        return "\0stub:meta-gen";
      }
      return undefined;
    },

    load(id, options) {
      // blocks.gen.ts — the CMS block registry (can be 10MB+).
      if (id.endsWith("blocks.gen.ts")) {
        // Client: stub — the browser receives pre-resolved sections.
        if (!options?.ssr) {
          return "export const blocks = {};";
        }

        // SSR: read .json sibling and emit JSON.parse(...) wrapper.
        // This avoids the Vite SSR module runner hanging on large dynamic
        // imports and lets V8 use its fast JSON parser (~2-10x vs object literal).
        const jsonPath = id.replace(/\.ts$/, ".json");
        if (existsSync(jsonPath)) {
          const raw = readFileSync(jsonPath, "utf-8");
          return `export const blocks = JSON.parse(${JSON.stringify(raw)});`;
        }

        // Fallback: if .json doesn't exist yet (pre-generate-blocks), let
        // Vite load the .ts file normally (may contain inline data for
        // backward-compatible sites that haven't regenerated).
      }

      // Virtual module stubs.
      return STUB_SOURCE[id];
    },

    configureServer(server) {
      // Watch `.deco/blocks/**/*.json` and regenerate `blocks.gen.json` when
      // CMS content changes (manual edit, sync-decofile, daemon PATCH).
      // After regen, we POST the new blocks to the dev server's own
      // /.decofile endpoint — this calls setBlocks() inside the workerd SSR
      // runtime without any module invalidation (which breaks TanStack
      // Start/Router state).
      //
      // NOTE: @decocms/nextjs takes the opposite approach — a generated
      // static-import manifest (blocks-cli's generate-blocks-manifest.ts,
      // wired as `createNextSetup({ blocks, blocksDir: false })`) that makes
      // the bundler's own module-graph invalidation the content-reload
      // mechanism. That design is deliberately NOT used here: a spike on
      // TanStack Start 1.166 × @cloudflare/vite-plugin showed ANY SSR module
      // invalidation bricks the router (the pre-existing upstream bug called
      // out above), so this plugin's no-invalidation delta machinery below
      // stays the TanStack dev-reload path until that's fixed upstream.
      //
      // Generator is loaded lazily via tsImport (same pattern as the daemon
      // below) so we don't depend on the consumer's TS loader.
      const cwd = process.cwd();
      const blocksDir = path.resolve(cwd, ".deco/blocks");
      const outFile = path.resolve(cwd, ".deco/blocks.gen.ts");
      const jsonFile = outFile.replace(/\.ts$/, ".json");

      // Lazily load the block generator module (generateBlocks for the cold-start
      // bootstrap, readBlockDelta for live edits). Same tsImport pattern as the
      // daemon loader below — keeps `tsx` scoped to this single import instead of
      // registering a global hook.
      let genModule;
      const loadGenModule = () => {
        if (genModule) return Promise.resolve(genModule);
        return import("tsx/esm/api")
          .then(({ tsImport }) =>
            tsImport("@decocms/blocks-cli/generate-blocks", import.meta.url),
          )
          .then((mod) => {
            if (typeof mod.generateBlocks !== "function") {
              // tsx 4.22.0–4.22.4 has a loader-hook state bug (fixed upstream
              // in 4.22.5, "isolate hook state per async module.register()
              // registration"): inside a Vite dev-server process, tsImport
              // resolves correctly but returns an EMPTY module namespace —
              // no rejection, no missing-module error. blocks-cli floors its
              // tsx dependency at ^4.22.5, but a site's own lockfile can pin
              // a broken copy that hoists above it. Fail with an actionable
              // message instead of the bare "generateBlocks is not a
              // function" this used to surface as.
              throw new Error(
                "tsImport(@decocms/blocks-cli/generate-blocks) returned an empty module namespace. " +
                  "This is the tsx 4.22.0–4.22.4 loader-hook bug — check `node -e \"console.log(require('tsx/package.json').version)\"` " +
                  "and upgrade tsx to >=4.22.5 (e.g. `bun update tsx` or pin a newer tsx in devDependencies).",
              );
            }
            genModule = mod;
            return mod;
          });
      };

      // In-memory copy of the merged decofile, seeded once from the full
      // generator run and patched with cheap deltas thereafter. Lets us keep
      // `blocks.gen.json` on disk fresh WITHOUT re-reading + re-parsing all
      // ~hundreds of `.deco/blocks/*.json` files on every edit (that whole-dir
      // re-read is what pegged the event loop for seconds and tripped the
      // Studio liveness probe).
      /** @type {Record<string, unknown> | null} */
      let mergedBlocks = null;
      const ensureMerged = async () => {
        if (mergedBlocks) return { merged: mergedBlocks, result: null };
        const { generateBlocks } = await loadGenModule();
        const result = await generateBlocks({ blocksDir, outFile, silent: true });
        mergedBlocks = result.empty ? {} : result.blocks;
        return { merged: mergedBlocks, result };
      };

      // Live block edits are applied as a DELTA. The Studio daemon (or a manual
      // edit) writes a single `.deco/blocks/*.json` file; re-reading and
      // re-merging the whole directory on every write blocks the Node/Vite event
      // loop for seconds. Instead we read only the changed file(s) and:
      //   1. patch the in-memory merged map and rewrite `blocks.gen.json` — this
      //      keeps the on-disk snapshot authoritative, because Vite's
      //      `full-reload` re-evaluates the SSR entry, which re-seeds
      //      setBlocks() from `blocks.gen.json`. A stale file here renders stale
      //      content on the auto-reload (only a later manual refresh, which does
      //      NOT re-evaluate, would show the edit).
      //   2. POST a delta envelope to `/.decofile` so the live isolate's
      //      in-memory snapshot is updated too (covers reloads that don't
      //      re-evaluate) — merged via applyDelta(), no module invalidation.
      let regenTimer = null;
      let regenInFlight = false;
      let regenQueued = false;
      /** @type {Map<string, boolean>} block filename -> isDelete (last event wins). */
      let pendingBlocks = new Map();
      const runDelta = async () => {
        if (regenInFlight) {
          regenQueued = true;
          return;
        }
        if (pendingBlocks.size === 0) return;
        regenInFlight = true;
        const batch = pendingBlocks;
        pendingBlocks = new Map();
        try {
          const { readBlockDelta } = await loadGenModule();
          const start = Date.now();
          const files = [...batch.entries()].map(([name, isDelete]) => ({
            name,
            isDelete,
          }));
          const delta = readBlockDelta({ blocksDir, files, silent: true });
          const keys = Object.keys(delta);
          if (keys.length === 0) return;

          // Patch the merged map + rewrite blocks.gen.json so an SSR re-eval on
          // reload reads fresh content. ensureMerged() seeds from a single full
          // run the first time (reading current disk, which already includes the
          // change); afterwards it's O(changed keys).
          const { merged } = await ensureMerged();
          for (const [name, value] of Object.entries(delta)) {
            if (value === null) delete merged[name];
            else merged[name] = value;
          }
          try {
            writeFileSync(jsonFile, JSON.stringify(merged));
          } catch (writeErr) {
            console.warn("[deco] failed to write blocks.gen.json:", writeErr?.message ?? writeErr);
          }

          // POST a delta envelope ({ blocks: {...} }) so handleDecofileReload
          // merges it over the current snapshot instead of replacing the whole
          // decofile. setBlocks() runs inside the workerd SSR runtime.
          const addr = server.httpServer?.address();
          const port = typeof addr === "object" && addr ? addr.port : 5173;
          const res = await fetch(`http://localhost:${port}/.decofile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ blocks: delta }),
          });
          const ms = Date.now() - start;
          if (res.ok) {
            console.log(`[deco] applied ${keys.length}-block delta in ${ms}ms`);
            server.hot?.send({ type: "full-reload", path: "*" });
          } else {
            console.warn(`[deco] block delta reload failed: ${res.status}`);
          }
        } catch (err) {
          console.warn("[deco] failed to apply block delta:", err?.message ?? err);
        } finally {
          regenInFlight = false;
          if (regenQueued) {
            regenQueued = false;
            scheduleRegen();
          }
        }
      };
      const scheduleRegen = () => {
        if (regenTimer) clearTimeout(regenTimer);
        regenTimer = setTimeout(() => {
          regenTimer = null;
          runDelta();
        }, 150);
      };

      // chokidar (Vite's watcher) needs the directory added explicitly because
      // `.deco/` lives outside the module graph it walks by default.
      if (existsSync(blocksDir)) {
        server.watcher.add(blocksDir);
      }
      const handleBlocksDirEvent = (file, isDelete) => {
        if (!file.endsWith(".json")) return;
        if (!file.startsWith(blocksDir + path.sep) && file !== blocksDir) return;
        // Block files are flat inside `.deco/blocks/`, so the basename is the
        // encoded-key + ".json" filename that readBlockDelta expects.
        pendingBlocks.set(path.basename(file), isDelete);
        scheduleRegen();
      };
      server.watcher.on("add", (file) => handleBlocksDirEvent(file, false));
      server.watcher.on("change", (file) => handleBlocksDirEvent(file, false));
      server.watcher.on("unlink", (file) => handleBlocksDirEvent(file, true));

      // Cold-start bootstrap of `blocks.gen.json`, in two modes:
      //
      // MISSING (fresh clone): blocks.gen.json is gitignored, so a first
      //   checkout has no file on disk. The async refresh below is
      //   fire-and-forget and races the first request — `setup.ts` reads the
      //   .json sibling via the blocks.gen.ts load() hook, and a miss falls
      //   back to the empty stub, rendering a blank page until regen lands and
      //   triggers a reload. So when the snapshot is ABSENT we generate it
      //   SYNCHRONOUSLY, blocking startup until the very first request can see
      //   real content. This only fires on a fresh clone, never steady-state.
      //
      // PRESENT (steady state): refresh asynchronously and DELIBERATELY NOT
      //   gated on mtime. A fresh git checkout rewrites every file's mtime to
      //   the checkout time, so a committed artifact could be CONTENT-stale yet
      //   mtime-"fresh" — the old `source.mtime > artifact.mtime` gate then
      //   served the stale snapshot (the double-render bug in branch previews).
      //   Regen is cheap (tens of ms) and fire-and-forget, so it never blocks
      //   startup. No POST /.decofile here — the SSR runtime isn't listening
      //   yet; `setup.ts` reads the freshly-written .json on the first request
      //   (the watch-driven path above handles live edits, with reload).
      if (existsSync(blocksDir)) {
        if (!existsSync(jsonFile)) {
          console.log("[deco] blocks.gen.json missing — generating on cold start…");
          try {
            const scriptPath = path.resolve(
              cwd,
              "node_modules/@decocms/blocks-cli/scripts/generate-blocks.ts",
            );
            execFileSync("npx", ["tsx", scriptPath], { cwd, stdio: "inherit" });
          } catch (err) {
            console.warn(
              "[deco] blocks.gen.json cold-start generation failed:",
              err?.message ?? err,
            );
          }
        } else {
          ensureMerged()
            .then(({ result }) => {
              if (result && !result.empty) {
                console.log(`[deco] bootstrapped ${result.count} blocks from .deco/blocks`);
              }
            })
            .catch((err) => {
              console.warn("[deco] blocks bootstrap failed:", err?.message ?? err);
            });
        }
      }

      // --- meta.gen.json auto-regeneration ---
      // When section/loader/app source files change (types, JSDoc, Props),
      // re-run generate-schema.ts so meta.gen.json stays in sync during dev.
      // No --out is passed to the generator below, so it writes to its own
      // default (.deco/meta.gen.json) — this constant must track that default.
      const schemaWatchDirs = ["src"];
      const schemaOutFile = path.resolve(cwd, ".deco/meta.gen.json");

      // Resolve the site name once from vite define or env.
      const definedSite = server.config.define?.["process.env.DECO_SITE_NAME"];
      const schemaSiteName = definedSite
        ? JSON.parse(definedSite)
        : process.env.DECO_SITE_NAME || "storefront";

      let schemaTimer = null;
      let schemaInFlight = false;
      let schemaQueued = false;
      const runSchemaGen = () => {
        if (schemaInFlight) {
          schemaQueued = true;
          return;
        }
        schemaInFlight = true;
        const start = Date.now();
        const scriptPath = path.resolve(
          cwd,
          "node_modules/@decocms/blocks-cli/scripts/generate-schema.ts",
        );
        const cmd = `npx tsx ${JSON.stringify(scriptPath)} --site ${schemaSiteName}`;
        exec(cmd, { cwd }, (err) => {
            schemaInFlight = false;
            if (err) {
              console.warn("[deco] schema generation failed:", err.message);
            } else {
              console.log(`[deco] meta.gen.json updated (${Date.now() - start}ms)`);
              // Invalidate the meta.gen.json module so SSR picks up fresh schema
              const mod =
                server.environments?.ssr?.moduleGraph?.getModuleById(schemaOutFile);
              if (mod) {
                server.environments.ssr.moduleGraph.invalidateModule(mod);
              }
            }
            if (schemaQueued) {
              schemaQueued = false;
              scheduleSchemaGen();
            }
          },
        );
      };
      const scheduleSchemaGen = () => {
        if (schemaTimer) clearTimeout(schemaTimer);
        schemaTimer = setTimeout(() => {
          schemaTimer = null;
          runSchemaGen();
        }, 500);
      };

      // Cold-start bootstrap: generate meta.gen.json if it's absent. The
      // artifact is gitignored (committing it causes constant PR conflicts), so
      // a fresh clone has no file on disk — yet setup.ts imports it EAGERLY via
      // createAdminSetup, so the import would reject on the first request.
      //
      // Unlike the blocks bootstrap above, this is (a) gated on absence and
      // (b) SYNCHRONOUS: a full ts-morph schema pass takes seconds, so we only
      // pay it when the file is genuinely missing, and we must finish before the
      // server accepts a request. Once the file exists on disk (any subsequent
      // start), this is skipped and the watch-driven regen below keeps it fresh.
      if (!existsSync(schemaOutFile)) {
        console.log("[deco] meta.gen.json missing — generating on cold start…");
        try {
          const scriptPath = path.resolve(
            cwd,
            "node_modules/@decocms/blocks-cli/scripts/generate-schema.ts",
          );
          execFileSync("npx", ["tsx", scriptPath, "--site", schemaSiteName], {
            cwd,
            stdio: "inherit",
          });
        } catch (err) {
          console.warn(
            "[deco] meta.gen.json cold-start generation failed:",
            err?.message ?? err,
          );
        }
      }

      const isSchemaSource = (file) => {
        const rel = path.relative(cwd, file);
        return (
          schemaWatchDirs.some((d) => rel.startsWith(d + path.sep)) &&
          (rel.endsWith(".tsx") || rel.endsWith(".ts"))
        );
      };
      server.watcher.on("change", (file) => {
        if (isSchemaSource(file)) scheduleSchemaGen();
      });
      server.watcher.on("add", (file) => {
        if (isSchemaSource(file)) scheduleSchemaGen();
      });

      // Tunnel + daemon: connect local dev to admin.deco.cx
      // Activated only when both DECO_SITE_NAME and DECO_ENV_NAME are set.
      // Omitting DECO_ENV_NAME runs Vite fully local (no tunnel registration),
      // since DECO_SITE_NAME alone is also consumed by site builds via vite's
      // `define` for `process.env.DECO_SITE_NAME` and shouldn't force a tunnel.
      const siteName = process.env.DECO_SITE_NAME;
      const envName = process.env.DECO_ENV_NAME;
      if (siteName && envName) {
        // Daemon files are .ts and live inside node_modules. Node's
        // experimental strip-types refuses to transpile node_modules, so
        // a plain dynamic `import()` blows up under `vite dev`. Use tsx's
        // ad-hoc loader (`tsImport`) — scoped to this import, doesn't
        // register a global hook.
        const loadDaemon = (specifier) =>
          import("tsx/esm/api").then(({ tsImport }) => tsImport(specifier, import.meta.url));

        // Add daemon middleware (x-daemon-api interception + auth + volumes + SSE + admin routes)
        loadDaemon("../daemon/middleware.ts")
          .then(({ createDaemonMiddleware }) => {
            server.middlewares.use(createDaemonMiddleware({ site: siteName, server }));
          })
          .catch((err) => {
            console.warn("[deco] Failed to load daemon middleware:", err.message);
          });

        // Start tunnel after HTTP server is listening (so we know the real port)
        server.httpServer?.once("listening", async () => {
          const addr = server.httpServer?.address();
          const port = typeof addr === "object" && addr ? addr.port : 5173;
          try {
            const { startTunnel } = await loadDaemon("../daemon/tunnel.ts");
            const tunnel = await startTunnel({
              site: siteName,
              env: envName,
              port,
              // Default to the .deco.host relay (matches startTunnel's documented
              // default). Set DECO_HOST=false to opt back into the legacy
              // simpletunnel.deco.site relay.
              decoHost: process.env.DECO_HOST !== "false",
            });
            server.httpServer?.on("close", () => tunnel.close());
          } catch (err) {
            console.warn("[deco] Failed to start tunnel:", err.message);
          }
        });
      }
    },

    config(_cfg, { command }) {
      /** @type {import("vite").UserConfig} */
      const cfg = {};

      // Allow tunnel domains through Vite's host check.
      // .deco.studio is the new admin frontend; both real-world Deco sites
      // (casaevideo-storefront, baggagio-tanstack) duplicated this list to
      // include it — bundling it here removes that boilerplate.
      if (process.env.DECO_SITE_NAME) {
        cfg.server = {
          allowedHosts: [".deco.host", ".decocdn.com", ".deco.studio"],
        };
      }

      // Inject a per-build identifier as `__DECO_BUILD_HASH__` so
      // createDecoWorkerEntry can fall back to it when env.BUILD_HASH is
      // unset (the default on Cloudflare Workers Builds, where there's
      // no GH-Actions step injecting --var BUILD_HASH).
      //
      // Dev gets the literal "dev" so SSR doesn't crash on an undefined
      // identifier; prod gets WORKERS_CI_COMMIT_SHA → git rev-parse →
      // time-based fallback (see resolveBuildHash above).
      const buildHash = command === "build" ? resolveBuildHash() : "dev";
      cfg.define = {
        ...cfg.define,
        __DECO_BUILD_HASH__: JSON.stringify(buildHash),
      };

      // Only split chunks for production builds — dev uses unbundled ESM.
      if (command !== "build") return cfg;
      return {
        ...cfg,
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
                  return "vendor-react";
                }

                // TanStack Router — client-side router (always needed)
                if (id.includes("@tanstack/react-router") || id.includes("@tanstack/router-core")) {
                  return "vendor-router";
                }

                // TanStack Start — specific checks before broad catch-all
                // (react-start-client includes "react-start" so must come first)
                if (
                  id.includes("@tanstack/react-start-client") ||
                  id.includes("@tanstack/start-client-core")
                ) {
                  return "vendor-router";
                }
                // Server-only TanStack packages — let Rollup tree-shake
                if (
                  id.includes("@tanstack/react-start-server") ||
                  id.includes("@tanstack/start-server-core")
                ) {
                  return undefined;
                }
                // Remaining @tanstack/start (storage-context, plugin-core, etc.)
                if (id.includes("@tanstack/start")) {
                  return "vendor-router";
                }

                // isbot — server-only (bot detection in resolve.ts)
                if (id.includes("node_modules/isbot")) {
                  return undefined;
                }

                if (id.includes("@tanstack/react-query")) {
                  return "vendor-query";
                }
                // Intentionally NOT splitting @decocms/tanstack,
                // @decocms/blocks, @decocms/blocks-admin, or
                // @decocms/apps: they have circular re-exports (e.g. apps
                // imports from runtime/sdk/cachedLoader, admin
                // imports from apps). Splitting them into separate chunks
                // produces a Rollup chunk-load order that crashes at runtime
                // ("undefined is not a function") — both real-world sites
                // worked around this by overriding manualChunks. Letting
                // Rollup bundle them together (or with the importing chunk)
                // is correct.
              },
            },
          },
        },
      };
    },

    configEnvironment(name, env) {
      if (name === "ssr" || name === "client") {
        env.optimizeDeps = env.optimizeDeps || {};
        env.optimizeDeps.esbuildOptions = env.optimizeDeps.esbuildOptions || {};
        env.optimizeDeps.esbuildOptions.jsx = "automatic";
        env.optimizeDeps.esbuildOptions.jsxImportSource = "react";
      }

      // Force @decocms/tanstack through the SSR transform pipeline so
      // TanStack Start's compiler can register its createServerFn handlers
      // (loadDeferredSection in routes/cmsRoute.ts, and loadCmsPage /
      // loadCmsHomePage alongside it) in the per-environment serverFnsById
      // manifest. Without this, Vite pre-bundles the package via
      // optimizeDeps before plugins run, the handler never enters the
      // manifest, and every POST /_serverFn/* call from the browser returns
      // HTTP 500 ("Invalid server function ID"). See #197.
      //
      // @decocms/apps-vtex does NOT need this: its invoke.ts has zero real
      // createServerFn call sites reachable by any site (it's a
      // codegen-time-only template that blocks-cli's generate-invoke.ts
      // statically parses, never imports, to emit each site's own
      // src/server/invoke.gen.ts with real top-level createServerFn consts;
      // createInvokeFn itself is a non-functional type-only marker for that
      // template, see sdk/createInvoke.ts's doc comment). Only add a
      // package here once it has a real `createServerFn(...)` call site.
      if (name === "ssr") {
        env.resolve = env.resolve || {};
        const existing = env.resolve.noExternal;
        const additions = ["@decocms/tanstack"];
        if (existing === true) {
          // Already noExternal everything — nothing to add.
        } else if (Array.isArray(existing)) {
          env.resolve.noExternal = [...new Set([...existing, ...additions])];
        } else if (existing) {
          env.resolve.noExternal = [existing, ...additions];
        } else {
          env.resolve.noExternal = additions;
        }

        // The noExternal setting above only controls whether Vite's SSR
        // *output* inlines vs. externalizes this package — it does NOT
        // stop Vite's dev-server-startup dependency optimizer (esbuild via
        // `optimizeDeps`) from pre-bundling it. Some Cloudflare Workers
        // targets (via @cloudflare/vite-plugin) already force
        // `resolve.noExternal = true` unconditionally for this same "ssr"
        // environment before this hook even runs, making the block above a
        // complete no-op there — yet the crash below still happened,
        // proving pre-bundling (not noExternal) was always the real cause.
        //
        // Confirmed via direct diagnostic instrumentation of
        // @tanstack/start-plugin-core: once esbuild pre-bundles this
        // package into a single node_modules/.vite/deps_ssr/*.js chunk,
        // Cloudflare's separate worker-export static-analysis pass
        // (getWorkerEntryExportTypes, a distinct pipeline stage from
        // Vite's own SSR transform — see workers/runner-worker in the
        // stack trace) throws "createServerFn must be assigned to a
        // variable!" on this package's own legitimate, already-top-level
        // createServerFn calls (loadCmsPage / loadCmsHomePage /
        // loadDeferredSection) — apparently that scan doesn't recognize
        // esbuild-bundled `var X = createServerFn(...)` output the same
        // way it recognizes the original, unbundled source. Excluding this
        // package from `optimizeDeps` entirely routes it through Vite's
        // normal plugin pipeline (where TanStack Start's compiler
        // transforms it correctly) instead of esbuild's pre-bundler.
        env.optimizeDeps = env.optimizeDeps || {};
        env.optimizeDeps.exclude = [...new Set([...(env.optimizeDeps.exclude || []), "@decocms/tanstack"])];
      }
    },

    generateBundle(_, bundle) {
      // Build a mapping from section key to chunk filename.
      // Sites use this to emit <link rel="modulepreload"> for eager sections.
      const map = {};
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && chunk.facadeModuleId) {
          const match = chunk.facadeModuleId.match(/\/(sections\/.+\.tsx)$/);
          if (match) {
            map["site/" + match[1]] = fileName;
          }
        }
      }
      if (Object.keys(map).length > 0) {
        this.emitFile({
          type: "asset",
          fileName: "section-chunks.json",
          source: JSON.stringify(map),
        });
      }
    },
  };

  return plugin;
}
