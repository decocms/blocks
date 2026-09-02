const ADMIN_ORIGINS = new Set([
  "https://admin.deco.cx",
  "https://v0-admin.deco.cx",
  "https://play.deco.cx",
  "https://admin-cx.deco.page",
  "https://deco.chat",
  "https://admin.decocms.com",
  "https://decocms.com",
  // Studio runs on decocms.com SUBDOMAINS — studio.decocms.com (prod),
  // pr-<n>.pr.studio.decocms.com (PR previews), *.local.studio.decocms.com /
  // *.preview-studio.decocms.com (sandbox/preview), and the native desktop
  // shell in dev (local.studio.decocms.com:4420). The host wildcard matches
  // subdomains at any depth; the ":*" port wildcard is REQUIRED because a
  // portless CSP host-source only matches the scheme's default port (443) —
  // it would miss the native dev origin's :4420. Together they let the Studio
  // preview iframes (section gallery, global-section preview) frame
  // /deco/render. Does NOT match the apex, so `https://decocms.com` stays.
  "https://*.decocms.com:*",
  // Local dev + packaged native shell: Studio (localhost:4000 web dev,
  // localhost:43120 packaged native) framing a cross-origin sandbox/preview
  // render. getAdminOrigins() is always non-empty here, so buildRenderCSP's
  // DEFAULT_ADMIN_ORIGINS localhost fallback never applies to /deco/render —
  // localhost must be listed explicitly (with ":*", same default-port reason)
  // for the dev/native preview iframe to load.
  "http://localhost:*",
  "https://localhost:*",
]);

/**
 * Register additional allowed admin origins.
 * Useful for self-hosted admin UIs or custom dashboards.
 */
export function registerAdminOrigin(origin: string): void {
  ADMIN_ORIGINS.add(origin);
}

/**
 * Register multiple additional allowed admin origins.
 */
export function registerAdminOrigins(origins: string[]): void {
  for (const origin of origins) {
    ADMIN_ORIGINS.add(origin);
  }
}

/**
 * The registered admin origins, as an array — for building a
 * `frame-ancestors` allowlist (e.g. the `/deco/render` CSP). Reflects any
 * origins added via `registerAdminOrigin(s)`.
 */
export function getAdminOrigins(): string[] {
  return [...ADMIN_ORIGINS];
}

export function isAdminOrLocalhost(request: Request): boolean {
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";

  if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return true;
  }

  for (const domain of ADMIN_ORIGINS) {
    if (origin.startsWith(domain)) return true;
  }
  return false;
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
    "Access-Control-Allow-Credentials": "true",
  };
}
