/**
 * Raw-CSS transforms for the Tailwind v3 -> v4 migration, applied to the
 * source site's custom CSS before it's appended to the generated
 * `src/styles/app.css` (see templates/app-css.ts).
 *
 * Covers two gotchas from the migration skill (references/css-styling.md):
 *   - the v3 `theme()` CSS helper function is gone in v4 — CSS-first config
 *     means theme values live as custom properties, so `theme(colors.x.y)`
 *     must become `var(--color-x-y)` (gotcha referenced alongside #48).
 *   - a custom class defined under `@layer components { .foo { @apply ...; } }`
 *     that other code `@apply`s or applies a variant to doesn't reliably
 *     participate in v4's utility pipeline — it needs to be a `@utility`
 *     (gotcha #49).
 */

export interface CssTransformResult {
  css: string;
  notes: string[];
}

// Maps a `theme()` path's first segment (Tailwind v3 `theme.colors`/
// `theme.extend.*` keys) to the CSS custom property prefix Tailwind v4
// generates for it under `@theme`.
const THEME_CATEGORY_TO_VAR_PREFIX: Record<string, string> = {
  colors: "color",
  color: "color",
  spacing: "spacing",
  fontFamily: "font",
  fontSize: "text",
  fontWeight: "font-weight",
  borderRadius: "radius",
  screens: "breakpoint",
  zIndex: "z",
  boxShadow: "shadow",
  letterSpacing: "tracking",
  lineHeight: "leading",
};

/**
 * Rewrite `theme(colors.gray.100)` -> `var(--color-gray-100)`,
 * `theme(spacing.4)` -> `var(--spacing-4)`, with fallback support:
 * `theme(colors.gray.100, #fff)` -> `var(--color-gray-100, #fff)`.
 * Unknown categories keep their name verbatim as the var prefix so the
 * rewrite is still valid CSS even if not a perfect v4 token match.
 */
export function rewriteThemeHelper(css: string): CssTransformResult {
  const notes: string[] = [];
  const re = /\btheme\(\s*(['"]?)([\w.-]+)\1\s*(?:,\s*([^)]+))?\)/g;

  const result = css.replace(re, (match, _quote, dottedPath, fallback) => {
    const [category, ...rest] = dottedPath.split(".");
    if (rest.length === 0) return match; // not a category.path reference, leave alone

    const prefix = THEME_CATEGORY_TO_VAR_PREFIX[category] ?? category;
    const varName = `--${prefix}-${rest.join("-")}`;
    const replacement = fallback ? `var(${varName}, ${fallback.trim()})` : `var(${varName})`;
    notes.push(`theme(${dottedPath}) -> var(${varName})`);
    return replacement;
  });

  return { css: result, notes };
}

/**
 * Find the span of a balanced-brace block starting at `openBraceIndex`
 * (the index of the `{`). Returns the index just after the matching `}`.
 */
function findMatchingBrace(css: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return css.length;
}

interface CssRule {
  selector: string;
  body: string;
}

/** Split the contents of a CSS block into its top-level rules (selector + brace-balanced body). */
function splitTopLevelRules(blockContent: string): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  while (i < blockContent.length) {
    const braceIdx = blockContent.indexOf("{", i);
    if (braceIdx === -1) break;
    const selector = blockContent.slice(i, braceIdx).trim();
    const end = findMatchingBrace(blockContent, braceIdx);
    const body = blockContent.slice(braceIdx + 1, end - 1);
    if (selector) rules.push({ selector, body });
    i = end;
  }
  return rules;
}

const SINGLE_CLASS_SELECTOR = /^\.([\w-]+)$/;

/**
 * Promote single-class rules inside `@layer components { ... }` to
 * top-level `@utility` blocks, which is what Tailwind v4 requires for a
 * custom class to be `@apply`-able / variant-composable elsewhere. Rules
 * with compound/multi-part selectors (`.foo .bar`, `.foo, .baz`) can't be
 * mechanically promoted — they're left inside `@layer components` and
 * flagged for manual review.
 */
export function promoteApplyClassesToUtility(css: string): CssTransformResult {
  const notes: string[] = [];
  const layerRe = /@layer\s+components\s*\{/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = layerRe.exec(css)) !== null) {
    const blockStart = match.index;
    const braceIdx = match.index + match[0].length - 1;
    const blockEnd = findMatchingBrace(css, braceIdx);
    const inner = css.slice(braceIdx + 1, blockEnd - 1);

    result += css.slice(cursor, blockStart);

    const rules = splitTopLevelRules(inner);
    const promoted: string[] = [];
    const remaining: CssRule[] = [];

    for (const rule of rules) {
      const singleClass = rule.selector.match(SINGLE_CLASS_SELECTOR);
      if (singleClass && rule.body.includes("@apply")) {
        promoted.push(`@utility ${singleClass[1]} {${rule.body}}`);
        notes.push(`Promoted .${singleClass[1]} from @layer components to @utility ${singleClass[1]} (Tailwind v4 requires this for @apply-ability)`);
      } else {
        remaining.push(rule);
        if (rule.body.includes("@apply")) {
          notes.push(`MANUAL: .${rule.selector} in @layer components uses @apply but has a compound selector — cannot auto-promote to @utility, verify it still resolves in Tailwind v4`);
        }
      }
    }

    result += promoted.join("\n\n");
    if (promoted.length > 0 && remaining.length > 0) result += "\n\n";
    if (remaining.length > 0) {
      const remainingBody = remaining.map((r) => `  ${r.selector} {${r.body}}`).join("\n\n");
      result += `@layer components {\n${remainingBody}\n}`;
    }

    cursor = blockEnd;
    layerRe.lastIndex = blockEnd;
  }

  result += css.slice(cursor);

  return { css: result, notes };
}

/** Run both raw-CSS transforms in sequence. */
export function transformCss(css: string): CssTransformResult {
  const notes: string[] = [];
  let result = css;

  const themeFix = rewriteThemeHelper(result);
  result = themeFix.css;
  notes.push(...themeFix.notes);

  const utilityFix = promoteApplyClassesToUtility(result);
  result = utilityFix.css;
  notes.push(...utilityFix.notes);

  return { css: result, notes };
}
