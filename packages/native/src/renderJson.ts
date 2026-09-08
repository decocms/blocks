/**
 * Client for the site's `?renderJson` endpoint — the page-as-JSON contract.
 *
 * The device is a *client* of the deployed worker, not a second copy of the
 * framework: the worker runs `resolveDecoPage` + the section loaders and hands
 * back finished props. Nothing here resolves the CMS, and nothing here needs
 * `URLPattern` (which Hermes does not have).
 *
 * Wire contract, served by `createDecoWorkerEntry`:
 *
 *   GET  <origin><path>?renderJson             → { name, path, sections }
 *   GET  <origin><path>?renderJson&__section=N → { component, props }
 *   404                                        → { status: 404, notFound: true }
 *
 * Each section is either resolved (`props`) or deferred (`lazyUrl`). Treat
 * `lazyUrl` as opaque — only the shape is contract.
 */

export type SerializedSection =
  | { component: string; props: Record<string, unknown> }
  | { component: string; lazyUrl: string };

export interface RenderJsonPage {
  name: string;
  path: string;
  sections: SerializedSection[];
}

export const isDeferred = (
  section: SerializedSection,
): section is { component: string; lazyUrl: string } => "lazyUrl" in section;

/** Thrown for any non-OK response so callers can branch on `notFound`. */
export class RenderJsonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly notFound = status === 404,
  ) {
    super(message);
    this.name = "RenderJsonError";
  }
}

export interface RenderJsonClientOptions {
  /** Origin of the deployed worker, e.g. `https://loja.example.com`. */
  baseUrl: string;
  /**
   * Marks the request as coming from the app so the CMS can serve an
   * app-specific variant of the same page — typically dropping the web
   * header/footer, since the app supplies native chrome.
   *
   * Sent as a query param rather than a User-Agent token because the same
   * client runs inside a WebView-less context and, on Expo web, inside an
   * `<iframe>` that cannot forge a UA. The site matches it with
   * `website/matchers/queryString.ts` (optionally OR-ed with a UA matcher).
   *
   * @default true
   */
  appVariant?: boolean;
  /** Injected for tests, or to add auth headers / a cookie jar. */
  fetcher?: typeof fetch;
}

/**
 * Per-path ETag memo.
 *
 * The endpoint answers `If-None-Match` with a 304, which on a phone is the
 * difference between re-downloading a page payload on every focus and sending
 * ~200 bytes. Kept beside the client (not in the page cache) so it survives
 * whatever caching the caller layers on top.
 */
type Cached = { etag: string; page: RenderJsonPage };

export function createRenderJsonClient(options: RenderJsonClientOptions) {
  const { baseUrl, appVariant = true, fetcher = fetch } = options;
  const etags = new Map<string, Cached>();

  const pageUrl = (path: string): string => {
    const url = new URL(path || "/", baseUrl);
    url.searchParams.set("renderJson", "");
    if (appVariant) url.searchParams.set("app", "1");
    return url.toString();
  };

  async function fetchPage(path = "/"): Promise<RenderJsonPage> {
    const url = pageUrl(path);
    const cached = etags.get(url);

    const response = await fetcher(url, {
      headers: cached ? { "If-None-Match": cached.etag } : undefined,
    });

    if (response.status === 304 && cached) return cached.page;

    if (!response.ok) {
      throw new RenderJsonError(`renderJson ${response.status} for ${path}`, response.status);
    }

    const page = (await response.json()) as RenderJsonPage;
    const etag = response.headers.get("ETag");
    if (etag) etags.set(url, { etag, page });
    return page;
  }

  /**
   * Resolves one deferred section. `lazyUrl` arrives relative and already
   * carries the page's query (including the app variant flag), so it is
   * resolved against `baseUrl` and otherwise left alone.
   */
  async function fetchSection(
    lazyUrl: string,
  ): Promise<{ component: string; props: Record<string, unknown> }> {
    const response = await fetcher(new URL(lazyUrl, baseUrl).toString());
    if (!response.ok) {
      throw new RenderJsonError(`renderJson section ${response.status}`, response.status);
    }
    return response.json();
  }

  return { fetchPage, fetchSection, pageUrl };
}

export type RenderJsonClient = ReturnType<typeof createRenderJsonClient>;
