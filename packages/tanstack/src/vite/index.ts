/**
 * `@decocms/tanstack/vite`: the Vite plugins a Deco TanStack site adds next to
 * `cloudflare()`, `tanstackStart()` and `react()`.
 *
 * ```ts
 * plugins: [
 *   cloudflare({ viteEnvironment: { name: "ssr" } }),
 *   tanstackStart(),
 *   react(),
 *   decoTanstack({ buildHash: process.env.WORKERS_CI_COMMIT_SHA }),
 * ]
 * ```
 *
 * - `decoContent()` from `@decocms/blocks/vite` (a block saved in the site
 *   editor reloads open pages in `vite dev`);
 * - `__BUILD_HASH__`, the build's id the worker keys its cache on: the commit
 *   (the CI's sha when given, else `git`, else the time), `"dev"` in `vite dev`;
 * - a browser stub for `node:async_hooks`, so server state never breaks the client build;
 * - one copy of React and the TanStack packages (`resolve.dedupe`).
 */
import { execFileSync } from "node:child_process";
import { decoContent } from "@decocms/blocks/vite";
import type { Plugin } from "vite";

const SHA_LENGTH = 12;

/**
 * The commit this build is made from (`git rev-parse --short=12 HEAD`), or the
 * time when git can't say (no git, not a repository), so two builds never share
 * a key by accident.
 */
export function gitBuildHash(cwd?: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", `--short=${SHA_LENGTH}`, "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    // no git here
  }
  return Date.now().toString(36);
}

/** The build hash for `vite build`: the CI's sha (shortened), else {@link gitBuildHash}. */
export function resolveBuildHash(ciSha: string | undefined, cwd?: string): string {
  const fromCi = ciSha?.trim();
  return fromCi ? fromCi.slice(0, SHA_LENGTH) : gitBuildHash(cwd);
}

const DEDUPE = [
  "@tanstack/react-start",
  "@tanstack/react-router",
  "@tanstack/react-start-server",
  "@tanstack/start-server-core",
  "@tanstack/start-client-core",
  "@tanstack/start-storage-context",
  "@decocms/blocks",
  "react",
  "react-dom",
];

const ASYNC_HOOKS_STUB = "\0decocms:async-hooks-stub";

/** `node:async_hooks` in the browser: the same shape, holding nothing. */
const ASYNC_HOOKS_STUB_SOURCE = `export class AsyncLocalStorage {
  run(_store, fn, ...args) { return fn(...args); }
  getStore() { return undefined; }
  enterWith() {}
  disable() {}
  exit(fn, ...args) { return fn(...args); }
}
export default { AsyncLocalStorage };
`;

export interface DecoTanstackOptions {
  /** The CI's commit sha (e.g. `process.env.WORKERS_CI_COMMIT_SHA`); without it, git's. */
  buildHash?: string;
}

export function decoTanstack(options: DecoTanstackOptions = {}): Plugin[] {
  const settings: Plugin = {
    name: "decocms:tanstack",
    config(_config, { command }) {
      const buildHash = command === "build" ? resolveBuildHash(options.buildHash) : "dev";
      return {
        define: { __BUILD_HASH__: JSON.stringify(buildHash) },
        resolve: { dedupe: DEDUPE },
      };
    },
  };
  const asyncHooksStub: Plugin = {
    name: "decocms:tanstack-async-hooks-stub",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.config.consumer === "client",
    resolveId(id) {
      return id === "node:async_hooks" || id === "async_hooks" ? ASYNC_HOOKS_STUB : undefined;
    },
    load(id) {
      return id === ASYNC_HOOKS_STUB ? ASYNC_HOOKS_STUB_SOURCE : undefined;
    },
  };
  return [settings, asyncHooksStub, decoContent()];
}
