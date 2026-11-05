/**
 * What a site needs to build its own page cache in front of the worker (the
 * README's worker-entry recipe): whether a request may be cached at all, the
 * version every key carries, and the version (draft or old release) a request
 * renders. The worker caches nothing itself.
 */
import { type CMS, matchRoute } from "@decocms/blocks";
import { VERSION_HEADER } from "../draft.ts";
import { hasDraftSignal } from "./drafts.ts";
import { serverFnPagePath } from "./serverFn.ts";

/**
 * Whether a request may be served from or stored in a shared cache at all:
 * a GET of the current release (`version` `null`: never a preview, a draft
 * or an old release), carrying no draft signal at all (no `?__draft=`, `off`
 * included, and no draft cookie: a preview always renders), outside local
 * development, without `Authorization`, and not one of TanStack Start's own
 * `/_build` files. The worker calls a
 * site's `pageCache` only for these.
 */
export function isCacheable(
  request: Pick<Request, "method" | "url" | "headers">,
  inputs: { version: string | null; dev?: boolean },
): boolean {
  return (
    request.method === "GET" &&
    inputs.version === null &&
    inputs.dev !== true &&
    !request.headers.has("authorization") &&
    !hasDraftSignal(request) &&
    !new URL(request.url).pathname.startsWith("/_build")
  );
}

/**
 * `<build>.<content revision>`, for every cache key: a new build or a
 * published release gets new entries at once. The build alone when the
 * revision can't be read.
 *
 * With `url` (the request's, `page.url`), the revision is the one the page
 * renders. Right after a publish, a page whose new blocks aren't cached yet is
 * served on the previous index while they load (the previous-index rule):
 * this pins the same way, on the page the URL routes to (for a server
 * function, the page its payload loads), so a page rendered on the previous
 * index is never stored under the new revision. Without `url`, the revision a
 * request that reads no page pins.
 */
export async function cacheVersion(
  cms: Pick<CMS, "forRelease">,
  buildHash: string,
  url?: URL,
): Promise<string> {
  let revision = "";
  try {
    const client = cms.forRelease();
    if (url !== undefined) {
      const [routes] = await client.routes();
      const match = matchRoute(serverFnPagePath(url) ?? url, { routes: routes ?? [] });
      // Pins on the page, as the page's own client does.
      if (match.kind === "match") client.prefetch(match.entry.name);
    }
    revision = await client.revision();
  } catch {
    // The content didn't load: key on the build only.
  }
  return [buildHash, revision].filter(Boolean).join(".");
}

/**
 * The version a request renders as the worker decided it (a Studio link's
 * draft pointer or release SHA, after the host allowlist), from the
 * `x-deco-version` header it sets; `null` for the current release. For the
 * request a `routes` handler or `pageCache` gets: the worker removes any copy
 * that arrives from outside.
 */
export function requestVersion(request: Pick<Request, "headers">): string | null {
  return request.headers.get(VERSION_HEADER) || null;
}
