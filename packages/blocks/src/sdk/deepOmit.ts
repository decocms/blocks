/**
 * deepOmit — immutably remove dotted paths from an object tree.
 *
 * Used by section `renderJson` projections to trim a section's props before it
 * is serialized for the mobile app (the ?renderJson page-as-JSON path):
 *
 * ```ts
 * export const renderJson = (props: SectionProps<typeof loader>) =>
 *   deepOmit(props, "storeConfig", "page.seo", "page.productsMap.*.hasFetchedSimilars");
 * ```
 *
 * Semantics:
 * - Top-level key: `deepOmit(o, "seoProps")`.
 * - Nested path (dot-separated): `deepOmit(o, "page.seo")`.
 * - Wildcard `*`: fans the remaining path over every array element OR record
 *   value — `"page.productsMap.*.hasFetchedSimilars"` strips `hasFetchedSimilars`
 *   from every value of `productsMap`.
 * - Arrays without an explicit `*`: the path auto-applies to each element and the
 *   array shape is preserved.
 * - Missing key: a no-op — never fabricates an `undefined` branch.
 *
 * Pure: spreads/copies at each level, never mutates the input.
 */
const omitAtPath = (obj: unknown, parts: string[]): unknown => {
  if (!obj || typeof obj !== "object" || parts.length === 0) return obj;
  const [key, ...rest] = parts;

  // `*` fans the remaining path out over every array element / record value.
  if (key === "*") {
    if (Array.isArray(obj)) return obj.map((v) => omitAtPath(v, rest));
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, omitAtPath(v, rest)]),
    );
  }
  // Preserve array shape: apply the same path to each element.
  if (Array.isArray(obj)) return obj.map((v) => omitAtPath(v, parts));

  const current = obj as Record<string, unknown>;
  if (rest.length === 0) {
    const copy = { ...current };
    delete copy[key];
    return copy;
  }
  if (!(key in current)) return current; // absent path = no-op, never creates undefined branches
  return { ...current, [key]: omitAtPath(current[key], rest) };
};

export const deepOmit = <T extends object>(obj: T, ...paths: string[]): T => {
  let result: unknown = obj;
  for (const path of paths) result = omitAtPath(result, path.split("."));
  return result as T;
};
