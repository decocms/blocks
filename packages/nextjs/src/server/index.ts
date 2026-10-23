/**
 * `@decocms/nextjs/server`: draft previews in Server Components (pages,
 * layouts, route handlers). Server only: it reads `next/headers`.
 *
 * The proxy decides what a request reads (`@decocms/nextjs/proxy`): the
 * version, the visitor, and each test and campaign on or off, forwarded on
 * `x-deco-version`, `x-deco-visitor` and `x-deco-assignments`. A page (and,
 * through those headers, the root layout) binds them before it reads
 * content, then reads through `contentClient(cms)`, which builds
 * `cms.client({ version, experiments, campaigns })` and decides nothing
 * again:
 *
 * ```tsx
 * export default async function Page({ searchParams }) {
 *   await bindDraft(cms, { searchParams: await searchParams });
 *   const client = contentClient(cms);
 *   …
 *   return <>{sections}<DraftPreviewIndicator /></>;
 * }
 * ```
 *
 * The host check is the proxy's (`decideDraft`), repeated here against the
 * same CMS, so a route the proxy doesn't match, or a forged `x-deco-version`,
 * still gets the release on a host that may not preview. On the release, a
 * test at 0% stays off whatever `x-deco-assignments` says.
 */

import type { Client, ClientOptions, CMS } from "@decocms/blocks";
import { parseVisitor } from "@decocms/blocks/experiments";
import { headers } from "next/headers.js";
import {
  ASSIGNMENTS_HEADER,
  type PathAssignments,
  parseAssignmentsSegment,
  withoutDarkTests,
} from "../assignments.ts";
import { DRAFT_PARAM, DRAFT_UNAVAILABLE_HEADER, VERSION_HEADER } from "../draft.ts";
import { allowedDraft, requestLike } from "../drafts.ts";
import { VISITOR_HEADER } from "../visitor.ts";
import { activeDraftPointer, draftSlot } from "./slot.ts";

export {
  ASSIGNMENTS_ROUTE_PREFIX,
  assignmentsSegment,
  type PathAssignments,
  parseAssignmentsSegment,
} from "../assignments.ts";
export { requestLike } from "../drafts.ts";
export { activeDraftPointer };

/** A page's `searchParams` prop, awaited. */
export type SearchParams = Record<string, string | string[] | undefined>;

export interface BindDraftOptions {
  /** The page's own `searchParams` (a layout has none: it reads the proxy's `x-deco-version`). */
  searchParams?: SearchParams;
}

type BindCMS = Pick<CMS, "readVersion" | "forRelease">;

function firstParam(searchParams: SearchParams | undefined, key: string): string | null {
  const raw = searchParams?.[key];
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

/**
 * Binds what the request reads: the version, if any (the page's own
 * `?__draft=` first, `off` leaving preview, then the version the proxy
 * forwarded on `x-deco-version`, then the draft cookie, each on a host the
 * CMS allows), and what the proxy decided (`x-deco-assignments`) and the
 * visitor it read (`x-deco-visitor`). Returns whether a version was bound:
 * a draft, or a published release's commit SHA (Studio's "Preview this
 * version"). It reads the request's headers, so it belongs on the draft
 * route; a cached (ISR) page reads what its path names (`assignedClient`).
 */
export async function bindDraft(cms: BindCMS, options: BindDraftOptions = {}): Promise<boolean> {
  if (await bindVersion(cms, options)) {
    // A preview renders per request anyway, and may switch on a test at 0%.
    await bindForwarded(cms, false);
    return true;
  }
  if (await variesByVisitor(cms)) await bindForwarded(cms, true);
  return false;
}

/** The visitor and the assignments the proxy forwarded, if any. */
async function bindForwarded(cms: BindCMS, release: boolean): Promise<void> {
  const requestHeaders = await headers();
  const slot = draftSlot();
  slot.visitor = parseVisitor(requestHeaders.get(VISITOR_HEADER));
  const decided = parseAssignmentsSegment(requestHeaders.get(ASSIGNMENTS_HEADER) ?? "");
  slot.assignments = decided && release ? await withoutDarkTests(cms, decided) : decided;
}

/**
 * Whether the release saves an `experiments` block (the built-in
 * `split-traffic`) or a `campaigns` block (the built-in `calendar`) with a
 * name in it: only then does a page vary by what the proxy decided. Read from
 * memory, unresolved; `false` when both are missing.
 */
async function variesByVisitor(cms: Pick<CMS, "forRelease">): Promise<boolean> {
  const saves = async (name: string, type: string): Promise<boolean> => {
    try {
      const [block] = await cms.forRelease().resolve<unknown>(name, { run: false });
      if (typeof block !== "object" || block === null) return false;
      const record = block as Record<string, unknown>;
      return (
        record.__resolveType === type && Object.keys(record).some((key) => key !== "__resolveType")
      );
    } catch {
      return false;
    }
  };
  const [tests, campaigns] = await Promise.all([
    saves("experiments", "split-traffic"),
    saves("campaigns", "calendar"),
  ]);
  return tests || campaigns;
}

async function bindVersion(cms: BindCMS, options: BindDraftOptions): Promise<boolean> {
  const { searchParams } = options;
  const param = firstParam(searchParams, DRAFT_PARAM);
  if (param === "off") return false;
  const requestHeaders = await headers();
  // The proxy read the link's draft and it's gone: the release, with the notice.
  if (requestHeaders.get(DRAFT_UNAVAILABLE_HEADER) === "1") {
    draftSlot().unavailable = true;
    return false;
  }
  const forwarded = param ?? requestHeaders.get(VERSION_HEADER);
  const query = forwarded ? `?${DRAFT_PARAM}=${encodeURIComponent(forwarded)}` : "";
  const request = requestLike(requestHeaders as Headers, `/${query}`);
  const version = request ? await allowedDraft(cms, request) : null;
  if (version === null) return false;
  draftSlot().version = version;
  return true;
}

/**
 * The content client for this request, from what `bindDraft` bound:
 * `cms.client({ version, experiments, campaigns })` with the tests and
 * campaigns the proxy decided, deciding nothing again. On a route the proxy
 * didn't decide for, the visitor and the preview's moment and switched tests
 * and campaigns decide instead. Create one per request.
 */
export function contentClient(cms: Pick<CMS, "client">): Client {
  const { version, visitor, assignments } = draftSlot();
  const options: ClientOptions = { visitor, version: version?.version ?? null };
  if (version?.date !== undefined) options.date = version.date;
  const experiments = over(version?.experiments, assignments?.experiments);
  const campaigns = over(version?.campaigns, assignments?.campaigns);
  if (experiments !== undefined) options.experiments = experiments;
  if (campaigns !== undefined) options.campaigns = campaigns;
  return cms.client(options);
}

/** `decided` over `preview`, name by name; `undefined` when neither has any. */
function over(
  preview: Readonly<Record<string, boolean>> | undefined,
  decided: Readonly<Record<string, boolean>> | undefined,
): Record<string, boolean> | undefined {
  if (preview === undefined && decided === undefined) return undefined;
  return { ...preview, ...decided };
}

/**
 * The content client of a page on the assignments route
 * (`app/%5Fassignments/[assignments]/[[...path]]`, which the proxy's
 * `rewriteToAssignmentsRoute` rewrites the CMS's pages to): the current
 * release, read as `cms.client({ experiments, campaigns })` with every test
 * and campaign the path's segment names on or off as the proxy decided, and
 * no visitor. The proxy decides, the page renders that, reading no request,
 * so Next can cache it (ISR, `revalidate = 600`). A test at 0% stays off
 * whatever the path names, and a test or a campaign the content doesn't have
 * stays out, never an error: a 404 here would be cached under the path by
 * Next. `null` only when the segment isn't one the proxy writes: the page
 * answers with `notFound()`.
 *
 * ```tsx
 * export const revalidate = 600;
 * export async function generateStaticParams() {
 *   return [];
 * }
 * export default async function Page({ params }) {
 *   const { assignments, path } = await params;
 *   const client = await assignedClient(cms, assignments);
 *   if (!client) notFound();
 *   …
 * }
 * ```
 */
export async function assignedClient(
  cms: Pick<CMS, "client" | "forRelease">,
  segment: string,
): Promise<Client | null> {
  const parsed = parseAssignmentsSegment(segment);
  if (parsed === null) return null;
  const assignments: PathAssignments = await withoutDarkTests(cms, parsed);
  return cms.client({ experiments: assignments.experiments, campaigns: assignments.campaigns });
}
