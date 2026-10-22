/**
 * TanStack Start's server-function URLs, as the worker and a site's own cache
 * read them: which paths are server functions, and the page a GET page load
 * asks for (the first local path in its `payload`).
 */

export function isServerFnPath(pathname: string): boolean {
  return pathname.startsWith("/_serverFn/") || pathname.startsWith("/_server/");
}

/**
 * The page a GET server-function request loads, from its `payload`: the first
 * string in it that is a local path. `null` for any other server function.
 */
export function serverFnPagePath(url: URL): string | null {
  if (!isServerFnPath(url.pathname)) return null;
  const payload = url.searchParams.get("payload");
  if (!payload) return null;
  let found: string | null = null;
  const visit = (v: unknown): void => {
    if (found !== null) return;
    if (typeof v === "string") {
      if (v.startsWith("/") && !v.startsWith("//")) found = v;
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  try {
    visit(JSON.parse(payload));
  } catch {
    return null;
  }
  return found;
}
