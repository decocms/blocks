/**
 * Centralized environment detection for @decocms/start.
 *
 * Works in Cloudflare Workers (wrangler dev), Node, and Vite SSR.
 * Evaluates lazily on first call so it picks up env vars set after module load.
 */

let _isDev: boolean | null = null;

/**
 * Reads `process.env.NODE_ENV` defensively.
 *
 * Wrapped in try/catch so the bare `process` reference can't throw in runtimes
 * without a `process` global (workerd without `nodejs_compat`). Bundlers that
 * statically define `process.env.NODE_ENV` (Vite/esbuild in Workers builds —
 * the same role the old `import.meta.env.DEV` signal served) replace this
 * expression with a string constant at build time, so no runtime `process`
 * global is needed in that path at all.
 */
function readNodeEnv(): string | undefined {
  try {
    return process.env.NODE_ENV;
  } catch {
    return undefined;
  }
}

/**
 * Returns `true` when running in a development environment.
 *
 * Detection order:
 *  1. `readNodeEnv() === "development"` — bundler-define-friendly read of
 *     `process.env.NODE_ENV` (see `readNodeEnv` above). This replaces the
 *     previous `import.meta.env.DEV` signal: `import.meta` is ESM-only syntax
 *     and is a hard syntax error when CJS consumers (ts-jest) compile this
 *     raw-TS package, and `env.ts` is reachable via the `@decocms/blocks/sdk`
 *     barrel, so any such consumer importing the barrel would fail to compile.
 *  2. `NODE_ENV=development` read off `globalThis.process.env` — standard
 *     Node/Vite convention, for runtimes where `process` is a real global.
 *  3. `DECO_PREVIEW=true` — explicit preview-mode override.
 *
 * The result is memoised after the first evaluation.
 */
export function isDevMode(): boolean {
  if (_isDev !== null) return _isDev;

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;

  const nodeEnvDev = readNodeEnv() === "development";

  _isDev = nodeEnvDev || env?.NODE_ENV === "development" || env?.DECO_PREVIEW === "true";

  return _isDev;
}
