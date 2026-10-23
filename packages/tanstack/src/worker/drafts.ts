/**
 * Which hosts may render drafts: the ones the CMS allows (`cms.readVersion`):
 * the addresses Studio writes into the current release's metadata, plus
 * `createCMS`'s `preview.hosts`; every host while the site has published no
 * list, or with no `site` and no `preview.hosts`. The site declares nothing
 * here (PO 2026-10-22).
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
import { type CMS, parseDraftPointer, parseVersion, type RequestVersion } from "@decocms/blocks";
import { DRAFT_COOKIE, DRAFT_PARAM } from "../draft.ts";

const DRAFT_OFF = "off";
/** A draft pointer's version that names no draft: the release, nothing fetched. */
const LOCAL_VERSION = "local";

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

/**
 * Whether a request carries a draft signal at all: `?__draft=` with any value
 * (`off` and a value that doesn't parse too) or the draft cookie. Such a
 * request is a preview: it never goes through a page cache and its response
 * is never cached (`draftResponseHeaders`), whatever the host check decides.
 */
export function hasDraftSignal(request: Pick<Request, "url" | "headers">): boolean {
  return (
    draftParam(new URL(request.url)) !== null ||
    readCookie(request.headers.get("cookie"), DRAFT_COOKIE) !== null
  );
}

/** Whether a version names a saved draft (a pointer, not a release's SHA and not `local`). */
function namesDraft(version: string): boolean {
  const parsed = parseDraftPointer(version);
  return parsed !== null && parsed.version !== LOCAL_VERSION;
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
  /**
   * The `Set-Cookie` the response carries: storing a link's version (the
   * worker sends it only with a response below 500), or ending a preview.
   */
  setCookie: string | null;
  /**
   * The link named a draft that can't be read (deleted, or its host
   * failing): the request renders the release, the cookie is expired when
   * the draft is gone (a failure that may pass leaves it), and the page says so calmly (`DraftBadge`'s `unavailable`), never a 500.
   */
  unavailable?: true;
}

/**
 * The version a request renders, and the cookie its response sets. A draft
 * pointer is read once before the page renders (`forDraft(...).revision()`,
 * the same read the page makes, shared while in flight): a draft that can't
 * be read gives the release and `unavailable`, never an error page.
 */
export async function decideDraft(
  cms: Pick<CMS, "readVersion" | "forDraft">,
  request: Request,
): Promise<DraftDecision> {
  const url = new URL(request.url);
  const param = draftParam(url);
  // Ending a preview is allowed on any host, so a cookie set earlier always goes.
  if (param === DRAFT_OFF) return { version: null, setCookie: expiredCookie() };
  const version = readDraftVersion(request);
  if (version === null) return { version: null, setCookie: null };
  if ((await cms.readVersion(request)) === null) return { version: null, setCookie: null };
  if (namesDraft(version.version)) {
    try {
      await cms.forDraft(version.version).revision();
    } catch (error) {
      // Gone (deleted): the preview ends. Any other failure (the drafts' host
      // down, a timeout) leaves the cookie alone, so the next request tries again.
      const setCookie = isDraftGone(error) ? expiredCookie() : null;
      return { version: null, setCookie, unavailable: true };
    }
  }
  // The link's own value goes in the cookie, its preview parameters with it.
  const fromLink = param !== null && parseVersion(param) !== null;
  return {
    version,
    setCookie: fromLink ? serializeCookie(encodeURIComponent(param), []) : null,
  };
}

/**
 * Whether a draft read failed because the drafts' host no longer has the
 * draft (`404`/`410`), as opposed to a failure that may pass (a `5xx`, a
 * timeout, a network error). Reads the error and its causes.
 */
function isDraftGone(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (/draft changes: HTTP (404|410)\b/.test(e.message)) return true;
  }
  return false;
}

/** The `Set-Cookie` that ends a preview. */
function expiredCookie(): string {
  return serializeCookie("", ["Max-Age=0"]);
}
