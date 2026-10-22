/**
 * Which hosts may render drafts: the ones the CMS allows (`cms.readVersion`):
 * the addresses Studio writes into the current release's metadata, plus
 * `createCMS`'s `preview.hosts` for content that isn't remote (local
 * development). The site declares nothing here (PO 2026-10-22).
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
 */
import { type CMS, parseVersion, type RequestVersion } from "@decocms/blocks";
import { DRAFT_COOKIE, DRAFT_PARAM } from "../draft.ts";

const DRAFT_OFF = "off";

function draftParam(url: URL): string | null {
  return url.searchParams.get(DRAFT_PARAM);
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
export function readDraftVersion(request: Request): RequestVersion | null {
  const param = draftParam(new URL(request.url));
  if (param === DRAFT_OFF) return null;
  const fromLink = param ? parseVersion(param) : null;
  if (fromLink !== null) return fromLink;
  return parseVersion(readCookie(request.headers.get("cookie"), DRAFT_COOKIE));
}

function serializeCookie(value: string, extra: string[]): string {
  // The same cookie `cms.draftCookie` writes (a test holds the two together).
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

export interface DraftDecision {
  /**
   * What this request's Studio link asks for, after the host check: the
   * version (a draft pointer, or a release's commit SHA) and the preview's
   * moment and switched tests and campaigns, in the shape of
   * `cms.client()`'s options; `null` for the current release.
   */
  version: RequestVersion | null;
  /** The `Set-Cookie` the response carries: storing a link's version, or ending a preview. */
  setCookie: string | null;
}

/** The version a request renders, and the cookie its response sets. */
export async function decideDraft(
  cms: Pick<CMS, "readVersion">,
  request: Request,
): Promise<DraftDecision> {
  const url = new URL(request.url);
  const param = draftParam(url);
  // Ending a preview is allowed on any host, so a cookie set earlier always goes.
  if (param === DRAFT_OFF) return { version: null, setCookie: serializeCookie("", ["Max-Age=0"]) };
  const version = readDraftVersion(request);
  if (version === null) return { version: null, setCookie: null };
  if ((await cms.readVersion(request)) === null) return { version: null, setCookie: null };
  // The link's own value goes in the cookie, its preview parameters with it.
  const fromLink = param !== null && parseVersion(param) !== null;
  return {
    version,
    setCookie: fromLink ? serializeCookie(encodeURIComponent(param), []) : null,
  };
}
