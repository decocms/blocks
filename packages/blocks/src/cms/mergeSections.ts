/**
 * Interleaves a page's eager and deferred sections back into the order the CMS
 * authored them.
 *
 * `resolveDecoPage` splits a page into two arrays — sections it resolved
 * eagerly and sections it deferred — but both carry the `index` they had in the
 * original flat section list. Rendering either array on its own would put a
 * deferred shelf at the bottom of the page instead of between the two banners
 * it was authored between; this puts them back.
 *
 * Pure array logic — no React, no DOM. It lives here rather than inside a
 * binding so every renderer (TanStack's `DecoPageRenderer`, the React Native
 * one, anything later) orders sections identically. A binding that reimplements
 * this drifts silently: the bug looks like "the CMS order is wrong", not like a
 * rendering bug.
 */

import type { DeferredSection, ResolvedSection } from "./resolve";

/** One entry in the merged page list — either resolved or still to be fetched. */
export type PageItem =
  | { type: "eager"; section: ResolvedSection; originalIndex: number }
  | { type: "deferred"; deferred: DeferredSection };

export function mergeSections(
  resolved: ResolvedSection[],
  deferred: DeferredSection[],
): PageItem[] {
  if (!resolved?.length && !deferred?.length) return [];
  const safeResolved = resolved ?? [];
  const safeDeferred = deferred ?? [];

  // Nothing deferred → input order is already the CMS order.
  if (!safeDeferred.length) {
    return safeResolved.map((s, i) => ({ type: "eager", section: s, originalIndex: i }));
  }

  // Sort by the `index` stamped by resolveDecoPage. An eager section missing
  // one falls back to its array position, which is the pre-deferral behavior.
  //
  // The sort key is kept beside the item rather than on it: `PageItem` is a
  // public type, and a stray `_sort` key would show up for anything iterating
  // an item's own keys.
  const keyed: { sort: number; item: PageItem }[] = [];

  for (let i = 0; i < safeResolved.length; i++) {
    const s = safeResolved[i];
    keyed.push({
      sort: s.index ?? i,
      item: { type: "eager", section: s, originalIndex: i },
    });
  }

  for (const d of safeDeferred) {
    keyed.push({ sort: d.index, item: { type: "deferred", deferred: d } });
  }

  // Array.prototype.sort is stable, so a tie (an eager section with no `index`
  // colliding with a deferred one) keeps eager-before-deferred — the order the
  // arrays were pushed in.
  keyed.sort((a, b) => a.sort - b.sort);

  return keyed.map((k) => k.item);
}
