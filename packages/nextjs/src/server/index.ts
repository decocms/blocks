/**
 * `@decocms/nextjs/server`: draft previews in Server Components (pages,
 * layouts, route handlers). Server only: it reads `next/headers`.
 *
 * A page (and, through the `x-deco-draft` header the proxy forwards, the root
 * layout) binds the request's draft before it reads content, then reads
 * through `contentClient(cms)`:
 *
 * ```tsx
 * export default async function Page({ searchParams }) {
 *   await bindDraft(cms, { searchParams: await searchParams, site: "my-store" });
 *   const client = contentClient(cms);
 *   …
 *   return <>{sections}<DraftPreviewIndicator /></>;
 * }
 * ```
 *
 * The host check is the proxy's (`decideDraft`), repeated here with the same
 * options, so a route the proxy doesn't match, or a forged `x-deco-draft`,
 * still gets the release on a host that may not preview.
 *
 * `bindDraft` also binds the visitor the proxy forwarded (`x-deco-visitor`,
 * from `decideVisitor`): always for a preview, and for the release only when
 * it has a saved `experiments` block, so a page with no test stays cacheable.
 * `contentClient` builds `cms.client({ visitor, version })` from what it
 * bound.
 */

import type { Client, CMS } from "@decocms/blocks";
import { parseVisitor, type Visitor } from "@decocms/blocks/experiments";
import { headers } from "next/headers.js";
import { type PathAssignments, parseAssignmentsSegment } from "../assignments.ts";
import { DRAFT_HEADER, DRAFT_PARAM } from "../draft.ts";
import { allowedDraft, isDraftPreviewEnabled, type PreviewPolicy, requestLike } from "../drafts.ts";
import { VISITOR_HEADER } from "../visitor.ts";
import { activeDraftPointer, draftSlot } from "./slot.ts";

export {
  ASSIGNMENTS_ROUTE_PREFIX,
  assignmentsSegment,
  type PathAssignments,
  parseAssignmentsSegment,
} from "../assignments.ts";
export { type PreviewPolicy, requestLike } from "../drafts.ts";
export { activeDraftPointer };

/** A page's `searchParams` prop, awaited. */
export type SearchParams = Record<string, string | string[] | undefined>;

export interface BindDraftOptions extends PreviewPolicy {
  /** The page's own `searchParams` (a layout has none: it reads the proxy's `x-deco-draft`). */
  searchParams?: SearchParams;
}

function firstParam(searchParams: SearchParams | undefined, key: string): string | null {
  const raw = searchParams?.[key];
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

/**
 * Binds the request's draft, if any: the page's own `?__draft=` first (`off`
 * leaves preview), then the pointer the proxy forwarded on `x-deco-draft`,
 * then the draft cookie, each on a host the options allow. Returns whether a
 * draft was bound. The draft may be a published release's commit SHA too
 * (Studio's "Preview this version"). Binds the visitor the proxy forwarded
 * too: with a preview, and on the release when it has a saved `experiments`
 * block. With previews off on every host and no `experiments` it returns
 * `false` without reading the request, so a cached (ISR) page stays cached.
 */
export async function bindDraft(
  cms: Pick<CMS, "readVersion" | "settings" | "forRelease">,
  options: BindDraftOptions = {},
): Promise<boolean> {
  if (await bindDraftPointer(cms, options)) {
    // A preview renders per request anyway: its visitor, for its own tests.
    await bindForwardedVisitor();
    return true;
  }
  if (await hasExperiments(cms)) await bindForwardedVisitor();
  return false;
}

/** The visitor the proxy forwarded on `x-deco-visitor`, if any. */
async function bindForwardedVisitor(): Promise<void> {
  draftSlot().visitor = parseVisitor((await headers()).get(VISITOR_HEADER));
}

/**
 * Whether the release saves an `experiments` block (the built-in
 * `split-traffic`) with a test in it: only then does a page vary per visitor.
 * Read from memory, unresolved; `false` when it is missing.
 */
async function hasExperiments(cms: Pick<CMS, "forRelease">): Promise<boolean> {
  try {
    const [block] = await cms.forRelease().resolve<unknown>("experiments", { run: false });
    if (typeof block !== "object" || block === null) return false;
    const record = block as Record<string, unknown>;
    return (
      record.__resolveType === "split-traffic" &&
      Object.keys(record).some((name) => name !== "__resolveType")
    );
  } catch {
    return false;
  }
}

async function bindDraftPointer(
  cms: Pick<CMS, "readVersion" | "settings" | "forRelease">,
  options: BindDraftOptions,
): Promise<boolean> {
  const { searchParams, ...policy } = options;
  if (!(await isDraftPreviewEnabled(cms, policy))) return false;
  const param = firstParam(searchParams, DRAFT_PARAM);
  if (param === "off") return false;
  const requestHeaders = await headers();
  const forwarded = param ?? requestHeaders.get(DRAFT_HEADER);
  const query = forwarded ? `?${DRAFT_PARAM}=${encodeURIComponent(forwarded)}` : "";
  const request = requestLike(requestHeaders as Headers, `/${query}`);
  const pointer = request ? await allowedDraft(cms, request, policy) : null;
  if (pointer === null) return false;
  draftSlot().pointer = pointer;
  return true;
}

/**
 * The content client for this request: `cms.client({ visitor, version })`
 * with what `bindDraft` bound, the version (a draft, an old release, or
 * `null` for the current one) and the visitor. Create one per request.
 */
export function contentClient(cms: Pick<CMS, "client">): Client {
  const { pointer, visitor } = draftSlot();
  return cms.client({ visitor, version: pointer });
}

/**
 * The visitor a path's assignments stand for: no id of its own, in the tests
 * the path names (v7's field `active`, which `assign` honours), so every
 * visitor on that side renders the same page. Each is recorded at 1%, the
 * smallest share that puts anyone in: `assign` keeps it while the test has a
 * share and, with no id to roll, leaves it off once the test is at 0%, so a
 * forged path can't switch on a test nobody is in.
 */
function visitorFromAssignments(assignments: PathAssignments): Visitor {
  const active = [...assignments.experiments];
  const pct = Object.fromEntries(active.map((name) => [name, 1]));
  return { id: "", active, inactiveDrawn: [], pct };
}

/**
 * The content client of a page on the assignments route
 * (`app/%5Fassignments/[assignments]/[[...path]]`, which the proxy's
 * `rewriteToAssignmentsRoute` rewrites the CMS's pages to): the current
 * release, read as `cms.client({ visitor, campaigns })` with what the proxy
 * decided, from the path's segment: a visitor in the tests it names and the
 * campaigns it names as the ones running. The proxy decides, the page renders
 * that, reading no request, so Next can cache it (ISR, `revalidate = 600`).
 * A test at 0% stays off whatever the path names, and a test or a campaign
 * the content doesn't have stays off, never an error: a 404 here would be
 * cached under the path by Next. `null` only when the segment isn't one the
 * proxy writes: the page answers with `notFound()`.
 *
 * ```tsx
 * export const revalidate = 600;
 * export async function generateStaticParams() {
 *   return [];
 * }
 * export default async function Page({ params }) {
 *   const { assignments, path } = await params;
 *   const client = assignedClient(cms, assignments);
 *   if (!client) notFound();
 *   …
 * }
 * ```
 */
export function assignedClient(cms: Pick<CMS, "client">, segment: string): Client | null {
  const assignments = parseAssignmentsSegment(segment);
  if (assignments === null) return null;
  return cms.client({
    visitor: visitorFromAssignments(assignments),
    campaigns: assignments.campaigns,
  });
}
