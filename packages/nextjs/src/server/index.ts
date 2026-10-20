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
 * On the release, `bindDraft` also binds the visitor's A/B assignments the
 * proxy forwarded (`x-deco-assignments`, from `decideAssignments`), and only
 * when the release has experiments, so a page with no test running stays
 * static. `contentClient` hands them to the release's client, where the
 * built-in `experiment` matcher reads them; a draft's client gets none.
 */

import type { Client, CMS } from "@decocms/blocks";
import { headers } from "next/headers.js";
import { ASSIGNMENTS_HEADER, decodeAssignments } from "../assignments.ts";
import { DRAFT_HEADER, DRAFT_PARAM } from "../draft.ts";
import { allowedDraft, isDraftPreviewEnabled, type PreviewPolicy, requestLike } from "../drafts.ts";
import { activeDraftPointer, draftSlot } from "./slot.ts";

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
 * draft was bound. Without one, binds the visitor's A/B assignments the proxy
 * forwarded, when the release has experiments. With previews off on every
 * host and no experiments it returns `false` without reading the request, so
 * a static page stays static.
 */
export async function bindDraft(
  cms: Pick<CMS, "draftPointer" | "settings" | "forRelease" | "experiments">,
  options: BindDraftOptions = {},
): Promise<boolean> {
  if (await bindDraftPointer(cms, options)) return true;
  await bindAssignments(cms);
  return false;
}

/** The visitor's assignments the proxy forwarded, when the release has experiments. */
async function bindAssignments(cms: Pick<CMS, "experiments">): Promise<void> {
  const experiments = await cms.experiments();
  if (Object.keys(experiments).length === 0) return;
  const value = (await headers()).get(ASSIGNMENTS_HEADER);
  if (value !== null) draftSlot().assignments = decodeAssignments(value);
}

async function bindDraftPointer(
  cms: Pick<CMS, "draftPointer" | "settings" | "forRelease">,
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
 * The content client for this request: the draft `bindDraft` bound (its
 * `experiment` rules `false`, the variants its pointer forces shown), or the
 * release with the visitor's A/B assignments `bindDraft` bound.
 */
export function contentClient(cms: Pick<CMS, "forDraft" | "forRelease">): Client {
  const { pointer, assignments } = draftSlot();
  if (pointer) return cms.forDraft(pointer);
  return assignments === null ? cms.forRelease() : cms.forRelease({ assignments });
}
