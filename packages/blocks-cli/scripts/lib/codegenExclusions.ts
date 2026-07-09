/**
 * Files the codegen scanners must never treat as section/loader sources.
 * `generate-schema.ts` once emitted a site's co-located test file as a
 * section block (it scans every .ts/.tsx under the sections dir), so both
 * generators route their directory walks through this predicate.
 *
 * Matches both the usual `<name>.test.ts` co-located form and a bare
 * `test.ts` / `spec.tsx` / `stories.ts` / `gen.ts` file (no prefix before
 * the dot) — `(?:^|\.)` anchors the marker word to either the start of the
 * filename or a preceding dot, so `testimonials.tsx` / `generic.ts` (marker
 * word embedded mid-identifier, not its own dot-delimited segment) are
 * correctly left INCLUDED.
 *
 * IMPORTANT: only ever apply this predicate to file entries, not
 * directories, during a directory walk — a directory named e.g.
 * `foo.gen.ts` is a real (if unusual) path segment, not a generated file,
 * and must still be descended into.
 */
const EXCLUDED_SUFFIX_RE = /(?:^|\.)(test|spec|stories|gen)\.(ts|tsx|js|jsx|json)$/;

export function isExcludedCodegenFile(fileName: string): boolean {
  return EXCLUDED_SUFFIX_RE.test(fileName);
}
