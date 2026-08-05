/**
 * Single source of truth for Tailwind v3 -> v4 and DaisyUI v4 -> v5 class
 * rename tables. Previously these tables were copy-pasted into three
 * places (`transforms/tailwind.ts`, `templates/app-css.ts`'s `@apply`
 * rewriter, and the standalone `scripts/tailwind-lint.ts` shipped into
 * migrated sites) and had drifted out of sync. Import from here instead of
 * redefining a table.
 *
 * Renames are applied via direct map lookup on each already-tokenized
 * utility class (not sequential string replacement), so scale-shift
 * entries like `shadow-sm -> shadow-xs` and `shadow -> shadow-sm` can't
 * cascade into each other in a single pass.
 */

/** Direct 1:1 Tailwind v3 -> v4 utility class renames. Empty string = remove entirely. */
export const CLASS_RENAMES: Record<string, string> = {
  // Flexbox/Grid
  "flex-grow-0": "grow-0",
  "flex-grow": "grow",
  "flex-shrink-0": "shrink-0",
  "flex-shrink": "shrink",

  // Overflow
  "overflow-ellipsis": "text-ellipsis",

  // Decoration
  "decoration-clone": "box-decoration-clone",
  "decoration-slice": "box-decoration-slice",

  // Transforms (v4 applies transforms automatically — the utility that used
  // to opt in no longer exists)
  "transform": "",
  "transform-gpu": "",
  "transform-none": "transform-none", // this one stays (explicit disable)

  // Filters (v4 applies automatically)
  "filter": "",
  "backdrop-filter": "",

  // Ring width default changed 3px -> 1px; explicit `ring` now means 1px,
  // so sites relying on the old 3px default need the explicit v3 width.
  "ring": "ring-3",

  // Outline: v3 `outline-none` (outline: 2px solid transparent, for focus
  // rings) renamed to `outline-hidden`; v4's new `outline-none` means a
  // literal `outline: none`.
  "outline-none": "outline-hidden",

  // Shadow/blur/rounded/drop-shadow scale shifted down one step, with a new
  // `-xs` step added at the bottom.
  "shadow-sm": "shadow-xs",
  "shadow": "shadow-sm",
  "blur-sm": "blur-xs",
  "blur": "blur-sm",
  "rounded-sm": "rounded-xs",
  "rounded": "rounded-sm",
  "drop-shadow-sm": "drop-shadow-xs",
  "drop-shadow": "drop-shadow-sm",

  // Linear gradients renamed to make room for radial-gradient/conic-gradient
  // utilities.
  "bg-gradient-to-t": "bg-linear-to-t",
  "bg-gradient-to-tr": "bg-linear-to-tr",
  "bg-gradient-to-r": "bg-linear-to-r",
  "bg-gradient-to-br": "bg-linear-to-br",
  "bg-gradient-to-b": "bg-linear-to-b",
  "bg-gradient-to-bl": "bg-linear-to-bl",
  "bg-gradient-to-l": "bg-linear-to-l",
  "bg-gradient-to-tl": "bg-linear-to-tl",
};

/**
 * DaisyUI v4 -> v5 class renames. Intentionally conservative — only
 * renames with a confirmed 1:1 replacement are listed here. Structural
 * breaks that have no mechanical class rename (collapse, btn-group,
 * form-control — see `detectDaisyUiV5StructuralIssues` below) are flagged
 * for manual review instead of guessed at.
 */
export const DAISYUI_RENAMES: Record<string, string> = {
  "badge-ghost": "badge-soft",
  "card-compact": "card-sm",
  "card-normal": "card-md",
  "tabs-boxed": "tabs-box",
};

/**
 * Rename a single class token, preserving any `modifier:` prefix chain
 * (`hover:`, `md:`, `dark:`, stacked or not) — e.g. `md:flex-grow` -> `md:grow`,
 * `hover:ring` -> `hover:ring-3`. Returns `""` if the rename removes the
 * class entirely (matching v4's dropped `transform`/`filter` utilities),
 * or the original token unchanged if no rename applies.
 *
 * This is the one place that knows how to apply CLASS_RENAMES/DAISYUI_RENAMES
 * to a token — every caller (JSX className rewriter, @apply rewriter,
 * tailwind-lint) must go through this instead of doing its own split/lookup,
 * or a variant-prefixed class silently stops getting renamed (as happened
 * when the @apply rewriter did a whole-token lookup without stripping the
 * modifier prefix first).
 */
export function renameToken(cls: string): string {
  const parts = cls.split(":");
  const utility = parts.pop()!;

  if (CLASS_RENAMES[utility] !== undefined) {
    const renamed = CLASS_RENAMES[utility];
    if (renamed === "") return "";
    if (renamed === utility) return cls;
    parts.push(renamed);
    return parts.join(":");
  }

  if (DAISYUI_RENAMES[utility] && DAISYUI_RENAMES[utility] !== utility) {
    parts.push(DAISYUI_RENAMES[utility]);
    return parts.join(":");
  }

  return cls;
}

// ── Spacing scale: px → Tailwind unit ───────────────────────────
export const PX_TO_SPACING: Record<number, string> = {};
for (let i = 0; i <= 96; i++) {
  PX_TO_SPACING[i * 4] = String(i);
}
PX_TO_SPACING[2] = "0.5";
PX_TO_SPACING[6] = "1.5";
PX_TO_SPACING[10] = "2.5";
PX_TO_SPACING[14] = "3.5";

// Text size: px → native class
export const TEXT_SIZE_MAP: Record<string, string> = {
  "12": "xs",
  "14": "sm",
  "16": "base",
  "18": "lg",
  "20": "xl",
  "24": "2xl",
  "30": "3xl",
  "36": "4xl",
  "48": "5xl",
  "60": "6xl",
  "72": "7xl",
  "96": "8xl",
  "128": "9xl",
};

export interface GotchaFinding {
  /** Gotcha number in the deco-to-tanstack-migration skill's css-styling.md */
  gotcha: number;
  message: string;
}

/**
 * Detect DaisyUI v4 classes/patterns with no mechanical v5 replacement —
 * gotcha #37 (`.collapse` broken under Tailwind v4; `btn-group` and
 * `form-control` were removed in DaisyUI v5 with no drop-in class rename).
 * Returns one finding per distinct pattern found in `content`, not one per
 * occurrence, to avoid flooding the report.
 */
export function detectDaisyUiV5StructuralIssues(content: string): GotchaFinding[] {
  const findings: GotchaFinding[] = [];

  if (/\bcollapse\b/.test(content) && /\bcollapse-(?:title|content)\b/.test(content)) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI .collapse usage found — its expand/collapse chain breaks under Tailwind v4. " +
        "Replace with native <details>/<summary> (see skill css-styling.md #37).",
    });
  }

  if (/\bbtn-group\b/.test(content)) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI v4 `btn-group` was removed in v5 with no drop-in class — rebuild with `join` (`join` container + `join-item` on each button).",
    });
  }

  if (/\bform-control\b/.test(content)) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI v4 `form-control` was removed in v5 with no drop-in class — rebuild with `fieldset` + `label`/`legend` per DaisyUI v5's form pattern.",
    });
  }

  if (/\bmenu-compact\b/.test(content)) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI v4 `menu-compact` was removed in v5 with no drop-in class — use `menu-sm` for a smaller menu or remove the modifier.",
    });
  }

  if (/\btab-bordered\b/.test(content)) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI v4 `tab-bordered` was removed in v5 — use `tabs-bordered` on the `tabs` wrapper instead of a modifier on each `tab` element.",
    });
  }

  // Detect bare `alert` without a color modifier — DaisyUI v5 changed the
  // default alert background; alerts without alert-info/success/warning/error
  // may appear with no background color.
  // Scoped to className= / class= attribute values to avoid matching the JS
  // global `alert()` function, variable names, or comments in the same file.
  if (
    /className=["'][^"']*\balert\b[^"']*["']/.test(content) &&
    !/\balert-(?:info|success|warning|error)\b/.test(content)
  ) {
    findings.push({
      gotcha: 37,
      message:
        "DaisyUI v5 changed `alert` default styling — a bare `alert` without a color modifier (alert-info/success/warning/error) may render with no background. Add an explicit color modifier or use `alert-soft` for a neutral variant.",
    });
  }

  return findings;
}

const MIXED_AXIS_GROUPS: Array<{ shorthand: string; sides: [string, string] }> = [
  { shorthand: "px", sides: ["pl", "pr"] },
  { shorthand: "mx", sides: ["ml", "mr"] },
  { shorthand: "py", sides: ["pt", "pb"] },
  { shorthand: "my", sides: ["mt", "mb"] },
];

/**
 * Detect gotcha #42: an element mixing a shorthand spacing utility (`px-*`)
 * with one of its longhand sides (`pl-*`/`pr-*`), possibly under different
 * responsive modifiers. Tailwind v4 emits logical properties
 * (`padding-inline` vs `padding-inline-start`), so the v3 "last one in the
 * cascade wins" behavior no longer holds across shorthand/longhand pairs.
 * `classes` is a single className string's already-split token list.
 */
export function detectLogicalPropertyConflict(classes: string[]): GotchaFinding[] {
  const findings: GotchaFinding[] = [];
  const utilities = classes.map((c) => c.split(":").pop() ?? c);

  for (const { shorthand, sides } of MIXED_AXIS_GROUPS) {
    const hasShorthand = utilities.some((u) => new RegExp(`^-?${shorthand}-`).test(u));
    const hasSide = utilities.some((u) => sides.some((s) => new RegExp(`^-?${s}-`).test(u)));
    if (hasShorthand && hasSide) {
      findings.push({
        gotcha: 42,
        message:
          `Mixed "${shorthand}-*" with "${sides[0]}-*"/"${sides[1]}-*" in the same className — ` +
          `Tailwind v4's logical properties (padding-inline vs padding-inline-start) don't cascade the same as v3's physical properties. ` +
          `Replace the shorthand with explicit longhand at every breakpoint (see skill css-styling.md #42).`,
      });
      break; // one finding per className string is enough signal
    }
  }

  return findings;
}
