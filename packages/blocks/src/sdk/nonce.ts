/**
 * Per-request CSP nonce.
 *
 * When the TanStack worker entry runs with `cspMode: "enforce"`, it generates a
 * fresh nonce per request, stashes it in the RequestContext bag (below), and
 * threads it into:
 *
 *   - the TanStack router (`router.options.ssr.nonce`), so `ScriptOnce` and the
 *     framework's own hydration scripts carry `nonce=…`;
 *   - the hand-written inline `<script>` tags in the deco layout / live-controls
 *     components (they read it via `getRequestNonce()`);
 *   - the enforced `Content-Security-Policy` header's `script-src`.
 *
 * Lives in `runtime` (not `tanstack`) so both the tanstack worker and the
 * runtime components (e.g. LiveControls) can reach it without crossing the
 * one-way package dependency graph.
 *
 * The nonce is only produced on the server and only in enforce mode; in the
 * browser the RequestContext is a no-op stub, so `getRequestNonce()` returns
 * `undefined` and every consumer degrades to "no nonce attribute".
 */
import { RequestContext } from "./requestContext";

/** RequestContext bag key holding the current request's CSP nonce. */
export const NONCE_BAG_KEY = "deco.csp.nonce";

/**
 * Generate a CSP nonce: 128 bits of CSPRNG randomness, base64-encoded. Fresh
 * per request — never reuse across responses, or the nonce loses all value.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The current request's CSP nonce, or `undefined` when CSP is not enforced
 * (report-only mode) or on the client. Read this in an SSR component to nonce
 * an inline `<script>`: `<script nonce={getRequestNonce()} … />`.
 */
export function getRequestNonce(): string | undefined {
  return RequestContext.getBag<string>(NONCE_BAG_KEY);
}
