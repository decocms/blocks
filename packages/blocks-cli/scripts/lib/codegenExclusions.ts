/**
 * Files the codegen scanners must never treat as section/loader sources.
 * `generate-schema.ts` once emitted a site's co-located test file as a
 * section block (it scans every .ts/.tsx under the sections dir), so both
 * generators route their directory walks through this predicate.
 */
const EXCLUDED_SUFFIX_RE = /\.(test|spec|stories|gen)\.(ts|tsx|js|jsx|json)$/;

export function isExcludedCodegenFile(fileName: string): boolean {
  return EXCLUDED_SUFFIX_RE.test(fileName);
}
