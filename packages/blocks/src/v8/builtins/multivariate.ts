import type { Variant } from "../types";

interface MultivariateProps<T> {
  variants?: Variant<T>[];
  /** The stable ID of an A/B test; results are kept per ID. */
  experiment?: string;
}

/**
 * `multivariate`: runs the first variant whose rule is `true` and returns its
 * value, or `undefined` when no rule is. Only the chosen variant runs, because
 * each `value` is a `Lazy<T>`. A value saved without the `lazy` wrapper (which
 * `deco check` flags) is returned as is rather than failing the page.
 */
export const multivariate = async <T>({
  variants,
}: MultivariateProps<T> = {}): Promise<T | undefined> => {
  if (!Array.isArray(variants)) return undefined;
  for (const variant of variants) {
    if (variant?.rule !== true) continue;
    const value = variant.value as unknown;
    return typeof value === "function" ? await (value as () => Promise<T>)() : (value as T);
  }
  return undefined;
};
