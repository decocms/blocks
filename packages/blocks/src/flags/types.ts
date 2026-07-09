/**
 * Types for the feature-flag primitives in this subpath.
 *
 * Ported from apps-start's `website/types.ts` (the flag/matcher slice only).
 * These are intentionally self-contained: `Matcher`/`MatchContext` here are
 * a *function-composition* matcher — a plain `(ctx) => boolean` imported and
 * invoked directly by TS code — which is a different mechanism from
 * `@decocms/blocks/matchers`'s CMS rule engine (`registerMatcher`/
 * `evaluateMatcher` dispatch by name over a `Record<string, unknown>` rule
 * against `MatcherContext` from `cms/resolve.ts`). The two don't share a
 * context shape (this `MatchContext` has `device`/`siteId`; the CMS one
 * doesn't), so they are not merged.
 */
import type { ImageWidget } from "../types/widgets";

export type { ImageWidget };

/**
 * Context passed to matchers at request time.
 * The framework populates this from the incoming request.
 */
export interface MatchContext {
  request: Request;
  device: "mobile" | "tablet" | "desktop";
  siteId: number;
}

/**
 * A matcher is a function that evaluates request context and returns a boolean.
 */
export type Matcher = (ctx: MatchContext) => boolean;

/**
 * A feature flag with a matcher and two branches.
 * The framework evaluates the matcher at request time and selects the
 * appropriate branch value.
 */
export interface FlagObj<T> {
  matcher: Matcher;
  true: T;
  false: T;
  name: string;
}

/**
 * A single variant in a multivariate flag.
 */
export interface Variant<T> {
  matcher?: Matcher;
  value: T;
  weight?: number;
}

/**
 * A multivariate flag with multiple variants, each with its own matcher.
 */
export interface MultivariateFlag<T> {
  variants: Variant<T>[];
}
