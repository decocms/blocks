/**
 * Runtime identification headers.
 *
 * Outbound: Cloudflare Workers' `fetch` sends NO `User-Agent` header at
 * all — unlike the old Deno runtime, where every outbound request carried
 * Deno's implicit `User-Agent: Deno/x.y.z`. UA-less requests are a strong
 * bot signal: Cloudflare managed WAF rules and Bot Fight Mode on partner
 * origins block them outright. `installDefaultUserAgent()` restores the
 * pre-migration behavior with an honest, allowlistable value, applied only
 * when the caller didn't set a User-Agent of its own.
 *
 * Responses: the old runtime stamped `x-powered-by: deco@<version>` on
 * every response (deco-cx/deco `utils/http.ts` defaultHeaders). The worker
 * entry reuses `DECO_POWERED_BY` for parity.
 */

import pkg from "../../package.json";

/**
 * Default outbound User-Agent. Stable prefix (`Deco/`) so partners can
 * write one WAF allowlist rule that survives version bumps and platform
 * changes; the URL comment tells whoever reads an access log who we are.
 */
export const DECO_USER_AGENT = `Deco/${pkg.version} (+https://deco.cx)`;

/** Response identification header value — parity with deco-cx/deco. */
export const DECO_POWERED_BY = `deco@${pkg.version}`;

/**
 * Cross-module guard on `globalThis` (same trick as logger.ts STATE_KEY):
 * bundlers may duplicate this module across chunks, so a module-local
 * boolean would not prevent double-wrapping.
 */
const INSTALLED_KEY = Symbol.for("deco.outboundHeaders.installed");

let restoreBaseFetch: (() => void) | undefined;

/**
 * Patch `globalThis.fetch` so every outbound request carries a User-Agent.
 *
 * Set-if-absent only: app-specific UAs (`deco-aws-app/1.0`, `decocx/1.0`,
 * ...) always win, matching the old runtime where Deno's default applied
 * only when unset. All other RequestInit members (method, body, signal,
 * `cf`, ...) pass through untouched. Idempotent — safe to call more than
 * once (e.g. worker entry + tests).
 */
export function installDefaultUserAgent(userAgent: string = DECO_USER_AGENT): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED_KEY]) return;
  g[INSTALLED_KEY] = true;

  const baseFetch = globalThis.fetch;
  restoreBaseFetch = () => {
    globalThis.fetch = baseFetch;
    delete g[INSTALLED_KEY];
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Fetch-spec semantics (same rule instrumentedFetch.ts documents):
    // when both a Request and `init.headers` are passed, `init.headers`
    // REPLACES the Request's headers — they do not union. So the headers
    // that will actually hit the wire are init.headers if present, else
    // the Request's own headers, else none.
    const base =
      init?.headers !== undefined
        ? init.headers
        : input instanceof Request
          ? input.headers
          : undefined;
    const headers = new Headers(base ?? undefined);
    if (headers.has("user-agent")) return baseFetch(input, init);
    headers.set("user-agent", userAgent);
    return baseFetch(input, { ...init, headers });
  }) as typeof fetch;
}

/** Test-only: restore the unpatched fetch. Do not call from app code. */
export function _uninstallDefaultUserAgentForTests(): void {
  restoreBaseFetch?.();
  restoreBaseFetch = undefined;
}
