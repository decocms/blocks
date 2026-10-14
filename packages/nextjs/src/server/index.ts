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
 */

import type { Client, CMS } from "@decocms/blocks";
import { headers } from "next/headers.js";
import { DRAFT_HEADER, DRAFT_PARAM } from "../draft.ts";
import { allowedDraft, isDraftPreviewEnabled, type PreviewPolicy, requestLike } from "../drafts.ts";
import { activeDraftPointer, draftSlot } from "./slot.ts";

export { isNextDev } from "../dev.ts";
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
 * draft was bound. With previews off on every host it returns `false`
 * without reading the request, so a static page stays static.
 */
export async function bindDraft(
  cms: Pick<CMS, "draftPointer" | "settings" | "forRelease">,
  options: BindDraftOptions = {},
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
 * The content client for this request: the draft `bindDraft` bound, or the
 * release.
 */
export function contentClient(cms: Pick<CMS, "forDraft" | "forRelease">): Client {
  const pointer = activeDraftPointer();
  return pointer ? cms.forDraft(pointer) : cms.forRelease();
}
