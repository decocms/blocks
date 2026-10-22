/**
 * What a site needs to build its own page cache in front of the worker (the
 * README's worker-entry recipe): whether a request may be cached at all, the
 * version every key carries, and the version (draft or old release) a request
 * renders. The worker caches nothing itself.
 */
import type { CMS } from "@decocms/blocks";
import { DRAFT_HEADER } from "../draft.ts";

/**
 * Whether a request may be served from or stored in a shared cache at all:
 * a GET of the current release (`version` `null`: never a preview, a draft
 * or an old release), outside local development, without `Authorization`,
 * and not one of TanStack Start's own `/_build` files. The worker calls a
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
    !new URL(request.url).pathname.startsWith("/_build")
  );
}

/**
 * `<build>.<content revision>`, for every cache key: a new build or a
 * published release gets new entries at once. The build alone when the
 * revision can't be read.
 */
export async function cacheVersion(
  cms: Pick<CMS, "forRelease">,
  buildHash: string,
): Promise<string> {
  let revision = "";
  try {
    revision = await cms.forRelease().revision();
  } catch {
    // The content didn't load: key on the build only.
  }
  return [buildHash, revision].filter(Boolean).join(".");
}

/**
 * The version a request renders as the worker decided it (a Studio link's
 * draft pointer or release SHA, after the host allowlist), from the
 * `x-deco-draft` header it sets; `null` for the current release. For the
 * request a `routes` handler or `pageCache` gets: the worker removes any copy
 * that arrives from outside.
 */
export function requestVersion(request: Pick<Request, "headers">): string | null {
  return request.headers.get(DRAFT_HEADER) || null;
}
