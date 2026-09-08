/**
 * Parses a DaisyUI class string into variants.
 *
 * The API is the class string on purpose: ported code keeps reading
 * `className="btn btn-primary btn-sm"`, so a diff against the web component
 * stays legible. But the classes are **never forwarded to `className`** — that
 * is the whole point of this layer.
 *
 * Why not forward them: DaisyUI classes are not inert in React Native, they
 * crash the style runtime. `btn` compiles to references to `var(--border)`,
 * `var(--size)`, `var(--radius-selector)` and `var(--color-primary-content)`,
 * which DaisyUI declares in
 * `:where(:root), :root:has(input.theme-controller[value=light]:checked), [data-theme="light"]`.
 * `:has()` and the attribute selector do not exist in RN, so NativeWind drops
 * that block wholesale and the runtime gets `undefined` — a `.length` throw
 * that takes the screen with it.
 *
 * What DOES survive is a plain `@theme` block, which is why the utilities these
 * components emit (`bg-primary`, `text-gray-500`) resolve to the site's own
 * colours. So the style still comes from the site's theme; only the DaisyUI
 * class names stop at this boundary.
 */

/** Semantic colours a DaisyUI component can take. */
export type DaisyColor =
  | "neutral"
  | "primary"
  | "secondary"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "error";

export type DaisySize = "xs" | "sm" | "md" | "lg" | "xl";

export interface DaisyVariants {
  color?: DaisyColor;
  size: DaisySize;
  /** `btn-outline` / `badge-outline` — border in the colour, transparent fill. */
  outline: boolean;
  /** `btn-ghost` — no fill, no border. */
  ghost: boolean;
  /** `btn-block` — full width. */
  block: boolean;
  /** `btn-circle` / `btn-square`. */
  circle: boolean;
  square: boolean;
  /** `btn-wide`. */
  wide: boolean;
  /** Classes that were not recognised, in source order. */
  rest: string[];
}

const COLORS: DaisyColor[] = [
  "neutral",
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
];
const SIZES: DaisySize[] = ["xs", "sm", "md", "lg", "xl"];

/**
 * Splits `className` into DaisyUI variants for `prefix` plus everything else.
 *
 * Unknown classes go to `rest` rather than being dropped: a caller writing
 * `className="btn btn-primary mt-4"` still wants `mt-4`, and silently eating it
 * would make the component look broken for a reason nobody can see.
 */
export function parseVariants(
  className: string | undefined,
  prefix: string,
): DaisyVariants {
  const variants: DaisyVariants = {
    size: "md",
    outline: false,
    ghost: false,
    block: false,
    circle: false,
    square: false,
    wide: false,
    rest: [],
  };
  if (!className) return variants;

  for (const token of className.split(/\s+/).filter(Boolean)) {
    if (token === prefix) continue;
    if (!token.startsWith(`${prefix}-`)) {
      variants.rest.push(token);
      continue;
    }
    const suffix = token.slice(prefix.length + 1);
    if ((COLORS as string[]).includes(suffix)) variants.color = suffix as DaisyColor;
    else if ((SIZES as string[]).includes(suffix)) variants.size = suffix as DaisySize;
    else if (suffix === "outline") variants.outline = true;
    else if (suffix === "ghost") variants.ghost = true;
    else if (suffix === "block") variants.block = true;
    else if (suffix === "circle") variants.circle = true;
    else if (suffix === "square") variants.square = true;
    else if (suffix === "wide") variants.wide = true;
    // A modifier this layer does not model yet (`btn-active`, `btn-link`, …).
    // Keeping it in `rest` means a later version can pick it up without any
    // caller changing.
    else variants.rest.push(token);
  }
  return variants;
}

/**
 * Background utility for a semantic colour.
 *
 * These resolve through the site's `@theme`, so `bg-primary` here is the same
 * value `bg-primary` has on the web.
 */
export const bgOf = (color?: DaisyColor) => (color ? `bg-${color}` : "bg-gray-200");

export const borderOf = (color?: DaisyColor) =>
  color ? `border-${color}` : "border-gray-300";

/**
 * Foreground for a filled surface.
 *
 * DaisyUI derives this from `--color-*-content`, which does not survive into
 * RN (same dropped block as above). White on a filled semantic colour is the
 * right call for every colour this site defines; a theme with a light
 * `primary` would need the real content colour, and that is the upgrade path.
 * ponytail: white-on-filled, read --color-*-content if a theme ever needs it.
 */
export const fgOf = (color?: DaisyColor) => (color ? "text-white" : "text-gray-900");

/** `join`/`class` helper — skips falsy so callers can inline conditionals. */
export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");
