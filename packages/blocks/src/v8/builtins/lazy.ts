import type { Lazy } from "../types";

/** Marks the built-in `lazy` function, the resolver's one special case. */
const LAZY_BLOCK: unique symbol = Symbol.for("decocms.blocks.v8.lazy");

/**
 * The built-in `lazy` block. The resolver never calls it: it sees the marker
 * and hands the parent a memoized `() => Promise<T>` that resolves `value`
 * only when called. Called directly (outside the resolver), it wraps an
 * already-resolved value, so it still honours the `Lazy<T>` contract.
 */
export const lazy = Object.assign(
  <T>({ value }: { value: T }): Lazy<T> =>
    () =>
      Promise.resolve(value),
  { [LAZY_BLOCK]: true as const },
);

export function isLazyBuiltin(fn: unknown): boolean {
  return (
    typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[LAZY_BLOCK] === true
  );
}
