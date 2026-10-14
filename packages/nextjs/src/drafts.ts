/**
 * Which hosts may render drafts: v7's allowlist (`@decocms/blocks` 7.x
 * `cms/draftSource.ts`: `readAllowedHosts`, `isDraftHostAllowed`,
 * `isDraftPreviewEnabled`), ported as is. v7 read its override from the
 * `DECO_ALLOWED_PREVIEW_HOSTS` variable; here it is the `previewHosts` option,
 * and the site passes the same options to the proxy (`decideDraft`) and to
 * its pages (`bindDraft`).
 *
 * - The site's own preview hosts: the ones it declares, in the `CMS` block or
 *   as `createCMS({ preview: { hosts } })` (matched as `cms.draftPointer`
 *   matches them). A site that declares none has none, as in v7: blocks'
 *   own default (every host) doesn't count as a declaration.
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
 * No React, no Next.js and no module state: the proxy and the pages share it.
 */
import {
  type CMS,
  DRAFT_COOKIE,
  DRAFT_PARAM,
  parseDraftPointer,
  type RequestLike,
} from "@decocms/blocks";

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
 * `false`, see {@link declaresPreviewHosts}).
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
  cms: Pick<CMS, "settings" | "forRelease">,
  policy: PreviewPolicy,
): Promise<boolean> {
  const override = overrideHosts(policy);
  if (override.includes("none")) return false;
  if (inferredPreviewHosts(policy.site).length > 0) return true;
  if (policy.previewHosts !== undefined) return override.length > 0;
  return (await declaresPreviewHosts(cms)) && (await cms.settings()).preview.hosts.length > 0;
}

/**
 * Whether the site declares its own preview hosts: in the `CMS` block, or as
 * `createCMS`'s `preview.hosts`. When it declares none, `cms.settings()`
 * reports blocks' default, every host (`["*"]`), which v7 never had: there,
 * a site without a list previewed only on its Deco hosts. The saved `CMS`
 * block tells an explicit `["*"]` from that default.
 */
export async function declaresPreviewHosts(
  cms: Pick<CMS, "settings" | "forRelease">,
): Promise<boolean> {
  const { hosts } = (await cms.settings()).preview;
  if (hosts.length !== 1 || hosts[0] !== "*") return true;
  try {
    const [block] = await cms.forRelease().resolve<unknown>("CMS", { run: false });
    const preview = isRecord(block) ? block.preview : undefined;
    return isRecord(preview) && ("hosts" in preview || "__resolveType" in preview);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * The pointer a request carries, as `@decocms/blocks` reads it: `?__draft=`
 * first, then the draft cookie; `null` for `?__draft=off` and for a value
 * that doesn't parse.
 */
export function readDraftPointer(request: RequestLike): string | null {
  const param = draftParam(request);
  if (param === DRAFT_OFF) return null;
  if (param && parseDraftPointer(param) !== null) return param;
  const cookie = readCookie(request.headers.get("cookie"), DRAFT_COOKIE);
  return cookie && parseDraftPointer(cookie) !== null ? cookie : null;
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
 * The draft `request` renders under `policy`, or `null` for the release: the
 * pointer it carries, on a host the policy (or, when only it can say, the
 * `CMS` block) allows.
 */
export async function allowedDraft(
  cms: Pick<CMS, "draftPointer" | "settings" | "forRelease">,
  request: RequestLike,
  policy: PreviewPolicy,
): Promise<string | null> {
  const pointer = readDraftPointer(request);
  if (pointer === null) return null;
  let host: string;
  try {
    host = new URL(request.url).host;
  } catch {
    return null;
  }
  const decision = previewHostDecision(host, policy);
  const allowed =
    decision === "cms"
      ? (await declaresPreviewHosts(cms)) && (await cms.draftPointer(request)) !== null
      : decision;
  return allowed ? pointer : null;
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

/** Whether the request's own `?__draft=` carries `pointer` (a draft link, not the cookie). */
export function fromDraftLink(request: RequestLike, pointer: string): boolean {
  return draftParam(request) === pointer;
}
