/**
 * Which hosts may render drafts: v7's allowlist (`@decocms/blocks` 7.x
 * `cms/draftSource.ts`: `readAllowedHosts`, `isDraftHostAllowed`,
 * `isDraftPreviewEnabled`), ported as is. v7 read its override from the
 * `DECO_ALLOWED_PREVIEW_HOSTS` variable; here it is the `previewHosts` option.
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
 * Hosts compare exactly, lowercased, port included (`localhost:5173`).
 *
 * The draft itself is the capability: a host check only bounds where a draft
 * link works. A request the check refuses gets the release, never an error.
 */
import { type CMS, DRAFT_COOKIE, DRAFT_PARAM, parseDraftPointer } from "@decocms/blocks";

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

/**
 * Whether `host` may preview without asking the CMS: `true` (an override or
 * inferred host), `false` (previews off, or the override leaves it out), or
 * `"cms"` when only the site's declared preview hosts can say (none declared:
 * `false`, see {@link declaresPreviewHosts}).
 */
export function previewHostDecision(host: string, policy: PreviewPolicy): boolean | "cms" {
  const override =
    policy.previewHosts === "none"
      ? ["none"]
      : (policy.previewHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (override.includes("none")) return false;
  const h = host.trim().toLowerCase();
  if (h === "") return false;
  if (inferredPreviewHosts(policy.site).includes(h)) return true;
  if (policy.previewHosts !== undefined) return override.includes(h);
  return "cms";
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
 * The pointer a request carries, as `@decocms/blocks` reads it: `?__draft=`
 * first, then the draft cookie; `null` for `?__draft=off` and for a value
 * that doesn't parse.
 */
export function readDraftPointer(request: Request): string | null {
  const param = draftParam(new URL(request.url));
  if (param === DRAFT_OFF) return null;
  if (param && parseDraftPointer(param) !== null) return param;
  const cookie = readCookie(request.headers.get("cookie"), DRAFT_COOKIE);
  return cookie && parseDraftPointer(cookie) !== null ? cookie : null;
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
  /** The draft this request renders, after the host check; `null` for the release. */
  pointer: string | null;
  /** The `Set-Cookie` the response carries: storing a draft link's pointer, or ending a preview. */
  setCookie: string | null;
}

/** The draft a request renders, and the cookie its response sets, under `policy`. */
export async function decideDraft(
  cms: Pick<CMS, "draftPointer" | "settings" | "forRelease">,
  request: Request,
  policy: PreviewPolicy,
): Promise<DraftDecision> {
  const url = new URL(request.url);
  const param = draftParam(url);
  // Ending a preview is allowed on any host, so a cookie set earlier always goes.
  if (param === DRAFT_OFF) return { pointer: null, setCookie: serializeCookie("", ["Max-Age=0"]) };
  const pointer = readDraftPointer(request);
  if (pointer === null) return { pointer: null, setCookie: null };
  const decision = previewHostDecision(url.host, policy);
  const allowed =
    decision === "cms"
      ? (await declaresPreviewHosts(cms)) && (await cms.draftPointer(request)) !== null
      : decision;
  if (!allowed) return { pointer: null, setCookie: null };
  const fromLink = param !== null && param === pointer;
  return {
    pointer,
    setCookie: fromLink ? serializeCookie(encodeURIComponent(pointer), []) : null,
  };
}
