/**
 * hex -> oklch triplet conversion + a post-process pass that fixes gotcha #43:
 * generated CSS emits `oklch(var(--x))` (daisyUI v5's opacity-modifier
 * pattern) but `--x` was assigned a hex color, not oklch coordinates.
 * `oklch(#B10200)` is invalid CSS — the color silently falls back to its
 * initial value, which is why SVG icons using `fill: oklch(var(--icon-color))`
 * render solid black on migrated sites.
 */

/**
 * True if `value` looks like bare oklch coordinates: 2-3 space-separated
 * numbers, optionally with a `/ alpha` suffix. E.g. "0.55 0.2 30" or
 * "0.85 0.15 120 / 0.5". Distinguishes oklch coordinate values from hex
 * colors or other CSS color syntaxes.
 */
export function isOklchCoordinates(value: string): boolean {
  const trimmed = value.trim();
  return /^[\d.]+\s+[\d.]+\s+[\d.]+(\s*\/\s*[\d.]+)?$/.test(trimmed);
}

function srgbChannelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Convert a hex color (#rgb, #rrggbb, #rrggbbaa) to an oklch coordinate
 * triplet string "L C H" (L in [0,1], C in [0, ~0.4], H in degrees
 * [0, 360)), matching the format expected by `oklch(var(--x))`.
 * Returns null if the input isn't a parseable hex color.
 */
export function hexToOklchTriplet(hex: string): string | null {
  const normalized = hex.trim().replace(/^#/, "");
  let r: number, g: number, b: number;

  if (normalized.length === 3) {
    r = parseInt(normalized[0] + normalized[0], 16);
    g = parseInt(normalized[1] + normalized[1], 16);
    b = parseInt(normalized[2] + normalized[2], 16);
  } else if (normalized.length === 6 || normalized.length === 8) {
    r = parseInt(normalized.slice(0, 2), 16);
    g = parseInt(normalized.slice(2, 4), 16);
    b = parseInt(normalized.slice(4, 6), 16);
  } else {
    return null;
  }
  if ([r, g, b].some((c) => Number.isNaN(c))) return null;

  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);

  // linear sRGB -> LMS (Björn Ottosson's OKLab matrices)
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.sqrt(a * a + b_ * b_);
  let H = (Math.atan2(b_, a) * 180) / Math.PI;
  if (H < 0) H += 360;

  return `${L.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)}`;
}

/**
 * Scan generated CSS for `oklch(var(--x))` usages, look up how `--x` was
 * declared elsewhere in the same stylesheet, and rewrite hex-valued
 * declarations to oklch triplets so the wrapper stays valid CSS.
 * rgb()/hsl()/named-color declarations are left as-is and reported so a
 * human can convert them (no lossless closed-form conversion is attempted
 * for those here).
 */
export function fixOklchHexMismatches(css: string): { css: string; fixed: string[]; flagged: string[] } {
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  const declaredValues = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(css)) !== null) {
    declaredValues.set(m[1], m[2].trim());
  }

  const usageRe = /oklch\(var\((--[\w-]+)\)\)/g;
  const fixed: string[] = [];
  const flagged: string[] = [];
  let result = css;

  const seen = new Set<string>();
  let usageMatch: RegExpExecArray | null;
  while ((usageMatch = usageRe.exec(css)) !== null) {
    const varName = usageMatch[1];
    if (seen.has(varName)) continue;
    seen.add(varName);

    const value = declaredValues.get(varName);
    if (!value || isOklchCoordinates(value)) continue;

    const hexMatch = value.match(/^#[0-9a-fA-F]{3,8}$/);
    if (hexMatch) {
      const triplet = hexToOklchTriplet(value);
      if (triplet) {
        const declPattern = new RegExp(
          `(${varName.replace(/[-]/g, "\\-")}\\s*:\\s*)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*;)`,
          "g",
        );
        result = result.replace(declPattern, `$1${triplet}$2`);
        fixed.push(`${varName}: ${value} -> oklch triplet ${triplet}`);
      }
      continue;
    }

    flagged.push(`${varName} is used as oklch(var(${varName})) but declared as "${value}" — not a hex or oklch-coordinate value; convert manually`);
  }

  return { css: result, fixed, flagged };
}
