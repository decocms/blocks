/**
 * Content Security Policy header utilities.
 *
 * Sets frame-ancestors to allow the Deco admin to embed the
 * storefront in an iframe for live preview.
 */

const DEFAULT_ADMIN_ORIGINS = ["https://admin.deco.cx", "https://deco.cx", "https://localhost:*"];

export interface CSPOptions {
  /** Additional origins allowed to frame the storefront. */
  extraOrigins?: string[];
  /**
   * Deco admin origins. Defaults to admin.deco.cx + localhost.
   * Set to empty array to disallow all external framing.
   */
  adminOrigins?: string[];
}

/**
 * Set Content-Security-Policy frame-ancestors header on a Response.
 *
 * This is required for the Deco admin live preview iframe to work.
 * Also removes X-Frame-Options if present (CSP supersedes it).
 *
 * @example
 * ```ts
 * import { setCSPHeaders } from "@decocms/start/sdk/csp";
 *
 * // In middleware:
 * const response = await next();
 * setCSPHeaders(response);
 * return response;
 * ```
 */
export function setCSPHeaders(response: Response, options?: CSPOptions): void {
  const origins = [
    "'self'",
    ...(options?.adminOrigins ?? DEFAULT_ADMIN_ORIGINS),
    ...(options?.extraOrigins ?? []),
  ];

  response.headers.set("Content-Security-Policy", `frame-ancestors ${origins.join(" ")}`);

  response.headers.delete("X-Frame-Options");
}

/**
 * Build the CSP header value string without applying it.
 * Useful when constructing headers in route definitions.
 */
export function buildCSPHeaderValue(options?: CSPOptions): string {
  const origins = [
    "'self'",
    ...(options?.adminOrigins ?? DEFAULT_ADMIN_ORIGINS),
    ...(options?.extraOrigins ?? []),
  ];
  return `frame-ancestors ${origins.join(" ")}`;
}

export interface RenderCSPOptions extends CSPOptions {
  /** Per-response nonce authorizing the framework's inline preview script. */
  nonce: string;
}

/**
 * Build a locked-down Content-Security-Policy for the `/deco/render` preview
 * HTML response.
 *
 * Threat model: `/deco/render` renders ANY registered section with fully
 * caller-controlled props as `text/html`, unauthenticated (it is a preview
 * endpoint). A caller-controlled prop that reaches an HTML sink (rich text into
 * `dangerouslySetInnerHTML`) is reflected XSS. This CSP is the execution-layer
 * mitigation: it forbids inline event handlers and un-nonced `<script>`, so an
 * injected `<img onerror=…>` or `<script>` cannot run — while still allowing
 * the framework's own inline preview script (tagged with `nonce`) and the
 * images / fonts / styles the previewed section needs in order to paint.
 *
 * `script-src` uses a nonce (NOT `'unsafe-inline'`): a nonce authorizes only
 * the framework `<script nonce="…">`. Inline event-handler ATTRIBUTES are never
 * matched by a nonce, so `onerror=` / `onload=` are blocked outright — that is
 * what neutralizes the reflected-XSS payloads. Non-`script` directives are kept
 * deliberately permissive (sections pull images/fonts from arbitrary commerce
 * CDNs); none of them is a script-execution sink.
 */
export function buildRenderCSP(options: RenderCSPOptions): string {
  const frameAncestors = [
    "'self'",
    ...(options.adminOrigins ?? DEFAULT_ADMIN_ORIGINS),
    ...(options.extraOrigins ?? []),
  ];
  return [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}'`,
    // Inline styles (`cssToStyle`) are not a JS-execution vector; keep them so
    // the preview renders. `https:` allows the site's stylesheet / CDN CSS.
    "style-src 'self' 'unsafe-inline' https:",
    // Previewed sections load images/fonts from many commerce CDNs.
    "img-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    "connect-src 'self' https:",
    "frame-src 'self' https:",
    "media-src 'self' https: data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors.join(" ")}`,
  ].join("; ");
}

/**
 * Generate a fresh base64 CSP nonce. Uses Web Crypto
 * (`crypto.getRandomValues`), available in Cloudflare Workers and Node ≥ 16
 * via `globalThis.crypto`. 16 bytes = 128 bits of entropy, per response.
 */
export function generateCSPNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
