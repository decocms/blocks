/**
 * Which hosts may render drafts: v7's allowlist (`@decocms/blocks` 7.x
 * `cms/draftSource.ts`: `readAllowedHosts`, `isDraftHostAllowed`,
 * `isDraftPreviewEnabled`), ported as is. v7 read its override from the
 * `DECO_ALLOWED_PREVIEW_HOSTS` variable; here it is the `previewHosts` option,
 * and the site passes the same options to the proxy (`decideDraft`) and to
 * its pages (`bindDraft`).
 *
 * - The site's own preview hosts: the ones it declares, in the `CMS` block or
 *   as `createCMS({ preview: { hosts } })` (matched as `cms.readVersion`
 *   matches them). A site that declares none has none, as in v7 (and as
 *   `cms.readVersion` reads it: no declared hosts, no version).
 * - The hosts Deco runs the site on, named after the site and always added:
 *   `<site>.deco.site` and `<site>.deco-cx.workers.dev`, exact.
 * - `previewHosts: [...]` replaces the site's own list (the inferred hosts are
 *   still added); `previewHosts: "none"` turns previews off on every host.
 *
 * Hosts compare exactly, lowercased, port included (`localhost:3000`). The
 * host is the one the visitor asked for: `x-forwarded-host` behind a proxy,
 * else `host`.
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

export interface PreviewPolicy {
  /** The site's name: `<site>.deco.site` and `<site>.deco-cx.workers.dev` may preview. */
  site?: string;
  /** Replaces the `CMS` block's preview hosts; `"none"` turns previews off everywhere. */
  previewHosts?: readonly string[] | "none";
}

/** The hosts Deco runs `site` on, which may always preview (unless previews are off). */
export function inferredPreviewHosts(site: string | undefined): string[] {
  const s = (site ?? "").trim().toLowerCase();
  return s ? [`${s}.deco.site`, `${s}.deco-cx.workers.dev`] : [];
}

function overrideHosts(policy: PreviewPolicy): string[] {
  if (policy.previewHosts === "none") return ["none"];
  return (policy.previewHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether `host` may preview without asking the CMS: `true` (an override or
 * inferred host), `false` (previews off, or the override leaves it out), or
 * `"cms"` when only the site's declared preview hosts can say (none declared:
 * `false`, as `cms.readVersion` answers).
 */
export function previewHostDecision(host: string, policy: PreviewPolicy): boolean | "cms" {
  const override = overrideHosts(policy);
  if (override.includes("none")) return false;
  const h = host.trim().toLowerCase();
  if (h === "") return false;
  if (inferredPreviewHosts(policy.site).includes(h)) return true;
  if (policy.previewHosts !== undefined) return override.includes(h);
  return "cms";
}

/**
 * Whether any host may preview (v7's `isDraftPreviewEnabled`): a page checks
 * it before it reads the request's headers, so a site with previews off never
 * turns a static page dynamic. `false` for `previewHosts: "none"`; `true` with
 * a site name or an override list; otherwise whether the site declares
 * preview hosts and they allow any.
 */
export async function isDraftPreviewEnabled(
  cms: Pick<CMS, "settings">,
  policy: PreviewPolicy,
): Promise<boolean> {
  const override = overrideHosts(policy);
  if (override.includes("none")) return false;
  if (inferredPreviewHosts(policy.site).length > 0) return true;
  if (policy.previewHosts !== undefined) return override.length > 0;
  return (await cms.settings()).preview.hosts.length > 0;
}

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
 * What `request` renders under `policy` (a draft pointer or a release's
 * commit SHA, with the preview's moment and switched tests and campaigns),
 * or `null` for the current release: what its Studio link carries, on a host
 * the policy (or, when only it can say, the `CMS` block) allows.
 */
export async function allowedDraft(
  cms: Pick<CMS, "readVersion">,
  request: RequestLike,
  policy: PreviewPolicy,
): Promise<RequestVersion | null> {
  const read = readDraftVersion(request);
  if (read === null) return null;
  let host: string;
  try {
    host = new URL(request.url).host;
  } catch {
    return null;
  }
  const decision = previewHostDecision(host, policy);
  const allowed = decision === "cms" ? (await cms.readVersion(request)) !== null : decision;
  return allowed ? read : null;
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
