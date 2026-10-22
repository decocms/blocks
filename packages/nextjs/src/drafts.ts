/**
 * Which hosts may render drafts: the ones the CMS allows (`cms.readVersion`):
 * the addresses Studio writes into the current release's metadata, plus
 * `createCMS`'s `preview.hosts`; every host while the site has published no
 * list, or with no `site` and no `preview.hosts`. The site declares nothing
 * here (PO 2026-10-22). The proxy
 * (`decideDraft`) and the pages (`bindDraft`) ask the same CMS.
 *
 * The host is the one the visitor asked for: `x-forwarded-host` behind a
 * proxy, else `host`.
 *
 * The draft itself is the capability: a host check only bounds where a draft
 * link works. A request the check refuses gets the release, never an error.
 *
 * What a link carries is a version, as `cms.readVersion` reads it: a draft
 * pointer, or a published release's commit SHA (Studio's "Preview this
 * version"), with the preview's moment and switched tests and campaigns
 * (`__at`, `__test`, `__campaign`; `parseVersion` from `@decocms/blocks`).
 * Both pass the same host check: a visitor on the live site never picks a
 * version.
 *
 * No React, no Next.js and no module state: the proxy and the pages share it.
 */
import { type CMS, parseVersion, type RequestLike, type RequestVersion } from "@decocms/blocks";
import { DRAFT_COOKIE, DRAFT_PARAM } from "./draft.ts";

const DRAFT_OFF = "off";

function draftParam(request: RequestLike): string | null {
  try {
    return new URL(request.url, "http://localhost").searchParams.get(DRAFT_PARAM);
  } catch {
    return null;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What a request's Studio link asks for, as `@decocms/blocks` reads it:
 * `?__draft=` first, then the draft cookie; `null` for `?__draft=off` and
 * for a value that doesn't parse.
 */
export function readDraftVersion(request: RequestLike): RequestVersion | null {
  const param = draftParam(request);
  if (param === DRAFT_OFF) return null;
  const fromLink = param ? parseVersion(param) : null;
  if (fromLink !== null) return fromLink;
  return parseVersion(readCookie(request.headers.get("cookie"), DRAFT_COOKIE));
}

/** Whether the request carries a draft signal at all: without one the CMS is never asked. */
export function hasDraftSignal(request: RequestLike): boolean {
  return (
    draftParam(request) !== null || readCookie(request.headers.get("cookie"), DRAFT_COOKIE) !== null
  );
}

/** The host the visitor asked for: the first `x-forwarded-host`, else `host`. */
export function requestHost(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || headers.get("host")?.trim();
  return host || null;
}

/**
 * The request as the draft check should see it: `pathAndQuery` on the host
 * the visitor asked for (`x-forwarded-host` behind a proxy, else `host`), so
 * the host check judges the public hostname rather than the origin's, or
 * `fallbackHost` when the headers name none. `null` when no host is known.
 */
export function requestLike(
  headers: Headers,
  pathAndQuery: string,
  fallbackHost?: string,
): RequestLike | null {
  const host = requestHost(headers) ?? (fallbackHost || null);
  if (!host) return null;
  try {
    return { url: new URL(pathAndQuery, `https://${host}`).href, headers };
  } catch {
    return null;
  }
}

/**
 * What `request` renders (a draft pointer or a release's commit SHA, with
 * the preview's moment and switched tests and campaigns), or `null` for the
 * current release: what its Studio link carries, on a host the CMS allows.
 */
export async function allowedDraft(
  cms: Pick<CMS, "readVersion">,
  request: RequestLike,
): Promise<RequestVersion | null> {
  const read = readDraftVersion(request);
  if (read === null) return null;
  return (await cms.readVersion(request)) === null ? null : read;
}

/**
 * The draft cookie: the same `Set-Cookie` `cms.draftCookie` writes (a test
 * holds the two together). Studio frames the site cross-site, hence
 * `SameSite=None; Partitioned`.
 */
export function draftCookie(value: string, extra: string[] = []): string {
  return [
    `${DRAFT_COOKIE}=${value}`,
    "Path=/",
    ...extra,
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
  ].join("; ");
}

/** Whether the request ends a preview (`?__draft=off`): the cookie goes on any host. */
export function endsPreview(request: RequestLike): boolean {
  return draftParam(request) === DRAFT_OFF;
}

/**
 * The request's own `?__draft=` value when it is a version (a draft link,
 * not the cookie): the value its cookie stores; `null` otherwise.
 */
export function draftLinkValue(request: RequestLike): string | null {
  const param = draftParam(request);
  return param && param !== DRAFT_OFF && parseVersion(param) !== null ? param : null;
}
