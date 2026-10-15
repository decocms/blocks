/**
 * v7's random matcher, sticky as the latest 7.x made it (`@decocms/blocks@7`
 * cms/resolve.ts' `evaluateVariantRule`): a visitor drawn into or out of a
 * test stays there, through the `deco_segment` cookie, until its traffic
 * share changes.
 *
 * ## The cohort is the saved block's name
 *
 * v7 keyed a visitor's decision on the name of the saved matcher block the
 * variant's rule pointed at ("Hero test"), or on `website/matchers/random.ts`
 * for a rule written inline. A v8 block function doesn't learn the name it was
 * saved under, so the name travels in the block itself: `cohort`. The
 * migration copies each saved random matcher's name into its `cohort`, and a
 * test created later should get one too. Keep it when changing the traffic
 * share: the cookie is keyed on it, so renaming it re-draws every visitor.
 *
 * ## Persisting the decision
 *
 * `random` and `decideRandom` record each decision on the request's `flags`
 * (see `MatcherContext`); after the page resolved, `segmentSetCookie(request,
 * flags)` gives the `Set-Cookie` to send. The framework subpaths
 * (`@decocms/compat-v7/tanstack`, `/nextjs`) do that wiring.
 */
import { type MatcherInput, v7Context } from "./context.ts";
import {
  parseSegmentCookie,
  SEGMENT_COOKIE,
  segmentSetCookie,
  stickyDecide,
  trafficToPct,
} from "./segment.ts";

/** The cohort v7 used for a random rule written inline instead of saved. */
export const INLINE_COHORT = "website/matchers/random.ts";

export interface RandomProps {
  /**
   * @title Traffic share
   * @description From 0 to 1: the share of visitors in the test group. 0.5 when left empty.
   */
  traffic?: number;
  /**
   * @title Cohort
   * @description Names the test in the visitor's cookie: the saved block's name. Keep it when changing the traffic share, so visitors stay in their group.
   */
  cohort?: string;
}

/** A sticky decision, and the cookie that keeps it. */
export interface RandomDecision {
  /** Whether the visitor is in the test group. */
  value: boolean;
  /** `true` when drawn on this request (a first visit or a re-draw), not read back. */
  isFresh: boolean;
  /**
   * The `Set-Cookie` value keeping every decision recorded on this request's
   * `flags` so far (this one included), or `null` when the visitor's cookie
   * already holds them. Always `null` without `flags`: nothing was recorded.
   */
  setCookie: string | null;
}

/**
 * The visitor's sticky decision for this random matcher: one already made on
 * this request, else the cookie's while the traffic share is unchanged (or
 * the cookie predates the fingerprint), else a fresh draw with
 * `Math.random()`, as in v7.
 */
export function decideRandom(props: RandomProps, request: MatcherInput): RandomDecision {
  const ctx = v7Context(request);
  const traffic = typeof props?.traffic === "number" ? props.traffic : 0.5;
  const name = typeof props?.cohort === "string" && props.cohort ? props.cohort : INLINE_COHORT;
  const { value, isFresh } = stickyDecide<boolean>({
    name,
    fingerprint: trafficToPct(traffic),
    recorded: ctx.flags,
    stored: parseSegmentCookie(ctx.cookies[SEGMENT_COOKIE]),
    roll: () => Math.random() < traffic,
    accepts: (v) => typeof v === "boolean",
  });
  return {
    value,
    isFresh,
    setCookie: ctx.flags ? segmentSetCookie(ctx.request, ctx.flags) : null,
  };
}

/**
 * @title Random
 * @description Puts a share of visitors in the test group, and keeps each visitor in their group.
 */
export function random(props: RandomProps, request: MatcherInput): boolean {
  return decideRandom(props, request).value;
}
