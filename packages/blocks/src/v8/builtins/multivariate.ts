import type { Variant } from "../types.ts";

interface MultivariateProps<T> {
  variants?: Variant<T>[];
  /** The stable ID of an A/B test; results are kept per ID. */
  experiment?: string;
}

/** Marks the built-in `multivariate`, whose rules the resolver evaluates in order. */
const MULTIVARIATE_BLOCK: unique symbol = Symbol.for("decocms.blocks.v8.multivariate");

/**
 * `multivariate`: runs the first variant whose rule is `true` and returns its
 * value, or `undefined` when no rule is. Only the chosen variant runs, because
 * each `value` is a `Lazy<T>`. A value saved without the `lazy` wrapper (which
 * `deco check` flags) is returned as is rather than failing the page.
 *
 * Inside the resolver, the rules also run in order and stop at the first
 * `true` one (as in v7): a later rule's matcher is never called, so a random
 * rule after the winner draws nothing and sets no cookie. The resolver hands
 * this function the variants up to the winner. A `multivariate` in the site's
 * block map replaces this one and gets every rule resolved, like any block.
 */
export const multivariate = Object.assign(
  async <T>({ variants }: MultivariateProps<T> = {}): Promise<T | undefined> => {
    if (!Array.isArray(variants)) return undefined;
    for (const variant of variants) {
      if (variant?.rule !== true) continue;
      const value = variant.value as unknown;
      return typeof value === "function" ? await (value as () => Promise<T>)() : (value as T);
    }
    return undefined;
  },
  { [MULTIVARIATE_BLOCK]: true as const },
);

export function isMultivariateBuiltin(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as Record<symbol, unknown>)[MULTIVARIATE_BLOCK] === true
  );
}
