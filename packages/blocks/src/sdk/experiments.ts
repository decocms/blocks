/**
 * Generic variant resolution — sticky, self-healing, N-way, and independent of
 * where the variant list comes from.
 *
 * ## What this is
 *
 * Two layers, deliberately separable:
 *
 * 1. {@link stickyDecide} — the assignment *policy*, extracted from
 *    `cms/resolve.ts`'s `evaluateVariantRule`: reuse the decision already made
 *    this request, else honour the `deco_segment` cookie while its fingerprint
 *    still matches, else roll fresh. Pure, synchronous, no CMS, no KV, no
 *    cookies. The CMS multivariate path and this module both call it, so the
 *    two cannot drift.
 * 2. {@link resolveExperimentVariant} — the N-way experiment on top of it:
 *    reads config from KV, draws from a weight vector, records the assignment
 *    for the framework to persist into `deco_segment`.
 *
 * ## Self-healing re-roll
 *
 * The stored fingerprint is a hash of the *weight vector*. Change a weight (a
 * ramp stage advancing 5% to 10%) and every stored assignment's fingerprint
 * goes stale, so each visitor is re-rolled exactly once and then re-sticks on
 * the new weights. The control plane never has to know this mechanic exists —
 * hence "no fingerprint field" in the published config.
 *
 * ## Why not `sdk/abTesting.ts`
 *
 * That is a binary `"worker" | "fallback"` whole-request proxy for the
 * migration period. Its bucket type, cookie, and fallback machinery are all
 * two-way-specific. Only its `kv.get<T>(key, "json")` shape is borrowed here.
 */

import { djb2 } from "./djb2";
import { parseSegmentCookie, SEGMENT_COOKIE, type StoredFlag } from "./flags";
import { getRuntimeEnv } from "./otelAdapters";
import { RequestContext } from "./requestContext";

// ---------------------------------------------------------------------------
// Layer 1 — the extracted sticky/re-roll core
// ---------------------------------------------------------------------------

/** Outcome of a sticky decision. `isFresh` is true when it was rolled now. */
export interface StickyDecision<V> {
  value: V;
  isFresh: boolean;
}

/**
 * Sticky assignment with self-healing re-roll, over any value type.
 *
 * Precedence: a decision already recorded this request (so every resolve pass
 * agrees) then the stored decision, if its fingerprint still matches, then a
 * fresh roll. `fingerprint === -1` on the stored decision marks a classic-deco
 * segment written without the blocks extension: honour it rather than
 * re-rolling, or every legacy visitor churns on first contact.
 *
 * @param name        Cohort identity — matcher block name or experiment key.
 * @param fingerprint Current config fingerprint; a mismatch re-rolls once.
 * @param recorded    Decisions already made this request (mutated: the new one
 *                    is pushed onto it). Undefined disables both dedupe and
 *                    persistence.
 * @param stored      Decisions parsed from the visitor's cookie.
 * @param roll        Draws a fresh value. Called at most once.
 * @param accepts     Guards a stored value that is no longer valid — e.g. a
 *                    variant deleted from the config. Rejected means re-roll.
 */
export function stickyDecide<V extends boolean | string>({
  name,
  fingerprint,
  recorded,
  stored,
  roll,
  accepts,
}: {
  name: string;
  fingerprint: number;
  recorded: StoredFlag[] | undefined;
  stored: StoredFlag[];
  roll: () => V;
  accepts?: (value: V) => boolean;
}): StickyDecision<V> {
  const already = recorded?.find((f) => f.name === name && f.pct === fingerprint);
  if (already) return { value: already.value as V, isFresh: false };

  const prev = stored.find((f) => f.name === name);
  const usable =
    prev !== undefined &&
    (prev.pct === -1 || prev.pct === fingerprint) &&
    (!accepts || accepts(prev.value as V));

  const value = usable ? (prev.value as V) : roll();
  recorded?.push({ name, value, pct: fingerprint });
  return { value, isFresh: !usable };
}

// ---------------------------------------------------------------------------
// Layer 2 — experiments
// ---------------------------------------------------------------------------

/** One arm of an experiment, as published by the control plane. */
export interface ExperimentVariant<P = unknown> {
  id: string;
  /** Integer share of traffic. Weights across an experiment must sum to 100. */
  weight: number;
  /** Opaque to the runtime — forwarded to the caller untouched. */
  payload: P;
}

/** An active experiment. */
export interface ExperimentDefinition<P = unknown> {
  /**
   * Stable, human-readable identity for the cohort — what analytics groups by.
   * Never encodes the target: gluing the two into one string forces a
   * `splitByChar` before every `GROUP BY`, the same objection contract 4
   * raises against gluing experiment and variant.
   */
  key: string;
  /**
   * What kind of surface this experiment targets, e.g. `"plp_ranking"`.
   * Mirrors the control plane's `experiments.target_kind`.
   */
  targetKind?: string;
  /**
   * Which specific surface, e.g. the VTEX collection id a PLP queries.
   * Mirrors the control plane's target id.
   *
   * Without this the runtime is handed an experiment with no way to know which
   * of a site's PLPs it belongs to, which forces callers to hardcode a page —
   * and a hardcoded page applies one PLP's arm to every other PLP sharing the
   * loader, serving the wrong catalogue.
   */
  target?: string;
  variants: ExperimentVariant<P>[];
}

/**
 * Frozen contract 1 — the document written to KV by the control plane's
 * `EXPERIMENT_ACTIVE_PUBLISH`, keyed by hostname. Only *active* experiments
 * appear: status and time-window logic live in the control plane, so the
 * runtime does no date math and parses no status.
 */
export interface ExperimentConfig<P = unknown> {
  version: number;
  experiments: ExperimentDefinition<P>[];
}

/** Frozen contract 2 — what a caller gets back. */
export interface ResolvedVariant<P = unknown> {
  experimentKey: string;
  variantId: string;
  payload: P;
  /** True when assigned on this request — a first visit or a re-roll. */
  isFresh: boolean;
}

/** The slice of a KV namespace this module uses (mirrors `abTesting.ts`). */
interface ExperimentKV {
  get<T>(key: string, type: "json"): Promise<T | null>;
}

/** Default Workers binding holding the published config. */
export const EXPERIMENTS_KV_BINDING = "EXPERIMENTS_KV";

/** Bag key for the per-request config read, so N loaders share one KV get. */
const CONFIG_BAG_KEY = "deco:experiments:config";
/** Bag key for assignments made this request, drained by the cookie writer. */
const ASSIGNMENTS_BAG_KEY = "deco:experiments:assignments";

/**
 * Fingerprint of a weight vector. Order-independent (the control plane may
 * reorder variants without meaning to re-roll anyone) and never `-1`, which is
 * reserved for "legacy cookie, no fingerprint".
 */
export function weightsFingerprint(variants: ExperimentVariant[]): number {
  const vector = [...variants]
    .map((v) => `${v.id}:${v.weight}`)
    .sort()
    .join("|");
  return djb2(vector) % 1_000_000;
}

/**
 * Draw a variant id from the weight vector. `rand` is a 0-1 sample.
 *
 * Weights are treated as shares of their own total rather than of a hardcoded
 * 100, so a config that violates the sum-to-100 contract still splits traffic
 * in the intended proportions instead of collapsing onto the first arm.
 */
export function pickWeightedVariant(variants: ExperimentVariant[], rand: number): string {
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0].id;

  let cursor = rand * total;
  for (const v of variants) {
    cursor -= Math.max(0, v.weight);
    if (cursor < 0) return v.id;
  }
  return variants[variants.length - 1].id;
}

/**
 * Read the published config for a hostname. Mirrors `abTesting.ts`'s
 * `kv.get<T>(key, "json")` shape. Returns null when the binding is absent, the
 * key is unset, or the document is unusable — every one of which must mean
 * "no experiment", never a thrown request.
 */
export async function readExperimentConfig<P = unknown>(
  kv: ExperimentKV | undefined,
  hostname: string,
): Promise<ExperimentConfig<P> | null> {
  if (!kv) return null;
  try {
    const config = await kv.get<ExperimentConfig<P>>(hostname, "json");
    if (!Array.isArray(config?.experiments)) return null;
    return { ...config, experiments: dedupeByKey(config.experiments) };
  } catch {
    return null;
  }
}

/**
 * Drop experiments repeating a `key` already seen, keeping the first.
 *
 * Target scoping makes several concurrent experiments per site normal, which
 * makes a key collision newly plausible — and its failure mode is severe and
 * silent. `deco_segment` stores one entry per name, so two experiments sharing
 * a key with different weight vectors have different fingerprints: each hop
 * between their surfaces looks like a ramp change, re-rolls the visitor, and
 * rewrites the cookie. That thrashes the assignment the analysis depends on
 * AND changes `__abf` on every navigation, so nothing caches.
 *
 * Losing one arm of a mis-published pair is bad; corrupting every assignment
 * on the site is worse, so the collision is contained here rather than left to
 * surface as unexplained cache misses.
 */
function dedupeByKey<P>(experiments: ExperimentDefinition<P>[]): ExperimentDefinition<P>[] {
  const seen = new Set<string>();
  return experiments.filter((e) => {
    if (!e?.key || seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
}

/**
 * Explicit inputs, for tests and for callers outside a request context.
 * Omitted fields fall back to the ambient {@link RequestContext} + Workers env.
 */
export interface ExperimentContext<P = unknown> {
  /** Skips the KV read entirely when provided. */
  config?: ExperimentConfig<P> | null;
  kv?: ExperimentKV;
  hostname?: string;
  /** Raw `deco_segment` cookie value from the request. */
  segmentCookie?: string;
  /** Assignment sink; the cookie writer drains it. */
  assignments?: StoredFlag[];
  /** Injectable RNG — tests pass a fixed sample. */
  random?: () => number;
}

/**
 * Resolve this visitor's variant for `experimentKey`.
 *
 * Returns null when no active experiment matches — no config published, the
 * key absent, or the experiment has no variants. Callers must behave exactly
 * as they do today on null.
 *
 * The assignment is recorded for persistence into the existing `deco_segment`
 * cookie under `experimentKey` (frozen contract 4); **the caller does not set
 * cookies itself**. Because it lands in that cookie, the CDN cache-key folding
 * already wired in `tanstack/sdk/workerEntry.ts` (`segmentCacheToken` to
 * `__abf`) covers it with no change, and analytics that already read
 * `deco_segment` see it for free.
 *
 * @example
 * ```ts
 * const variant = await resolveExperimentVariant<{ collectionId: string }>("plp-ranking");
 * if (!variant) return vtexProductListingPage(props, req, ctx); // unchanged path
 * props.selectedFacets = [
 *   ...(props.selectedFacets ?? []),
 *   { key: "productClusterIds", value: variant.payload.collectionId },
 * ];
 * ```
 */
export async function resolveExperimentVariant<P = unknown>(
  experimentKey: string,
  ctx: ExperimentContext<P> = {},
): Promise<ResolvedVariant<P> | null> {
  const config = ctx.config !== undefined ? ctx.config : await loadConfig<P>(ctx);
  return decide(
    config?.experiments.find((e) => e.key === experimentKey),
    ctx,
  );
}

/**
 * Resolve the experiment targeting one specific surface.
 *
 * The key answers "which cohort"; this answers "which of the site's PLPs".
 * A site has many surfaces of the same kind — FARM Rio alone has ~953
 * collection-driven PLPs — and an arm's payload is precomputed for exactly
 * one of them, so looking an experiment up by key alone would apply one page's
 * arm to all of them.
 *
 * Returns null when no active experiment targets `(targetKind, target)`,
 * which is the overwhelmingly common case: an untargeted surface records no
 * assignment and behaves exactly as it does today. Exposure therefore always
 * means "could actually be affected", which is what the analysis requires.
 */
export async function resolveExperimentForTarget<P = unknown>(
  targetKind: string,
  target: string,
  ctx: ExperimentContext<P> = {},
): Promise<ResolvedVariant<P> | null> {
  const config = ctx.config !== undefined ? ctx.config : await loadConfig<P>(ctx);
  return decide(
    config?.experiments.find((e) => e.targetKind === targetKind && e.target === target),
    ctx,
  );
}

/**
 * The assignment itself, shared by both lookups so they cannot drift.
 * Always keyed on `experiment.key`, never on the target — the cookie and the
 * analytics join both identify the cohort, not the surface.
 */
function decide<P>(
  experiment: ExperimentDefinition<P> | undefined,
  ctx: ExperimentContext<P>,
): ResolvedVariant<P> | null {
  if (!experiment?.variants?.length) return null;

  const stored = parseSegmentCookie(ctx.segmentCookie ?? ambientSegmentCookie());
  const random = ctx.random ?? Math.random;
  const { value: variantId, isFresh } = stickyDecide<string>({
    name: experiment.key,
    fingerprint: weightsFingerprint(experiment.variants),
    recorded: ctx.assignments ?? ambientAssignments(),
    stored,
    roll: () => pickWeightedVariant(experiment.variants, random()),
    // A variant retired mid-flight leaves visitors holding a dead id. Re-roll
    // them onto a live arm instead of returning a payload that no longer exists.
    accepts: (id) => experiment.variants.some((v) => v.id === id),
  });

  const variant = experiment.variants.find((v) => v.id === variantId) ?? experiment.variants[0];
  return {
    experimentKey: experiment.key,
    variantId: variant.id,
    payload: variant.payload,
    isFresh,
  };
}

// ---------------------------------------------------------------------------
// Ambient request wiring
// ---------------------------------------------------------------------------

/**
 * One KV read per request, shared by every caller, memoised on the in-flight
 * promise so concurrent section loaders coalesce instead of racing.
 */
function loadConfig<P>(ctx: ExperimentContext<P>): Promise<ExperimentConfig<P> | null> {
  const kv = ctx.kv ?? (getRuntimeEnv()?.[EXPERIMENTS_KV_BINDING] as ExperimentKV | undefined);
  const hostname = ctx.hostname ?? ambientHostname();
  if (!kv || !hostname) return Promise.resolve(null);

  const cached = RequestContext.getBag<Promise<ExperimentConfig<P> | null>>(CONFIG_BAG_KEY);
  if (cached) return cached;

  const pending = readExperimentConfig<P>(kv, hostname);
  RequestContext.setBag(CONFIG_BAG_KEY, pending);
  return pending;
}

function ambientHostname(): string | undefined {
  const request = RequestContext.current?.request;
  return request ? new URL(request.url).hostname : undefined;
}

function ambientSegmentCookie(): string | undefined {
  const cookies = RequestContext.current?.request?.headers.get("cookie");
  if (!cookies) return undefined;
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SEGMENT_COOKIE}=([^;]+)`));
  return match?.[1];
}

function ambientAssignments(): StoredFlag[] | undefined {
  if (!RequestContext.current) return undefined;
  const existing = RequestContext.getBag<StoredFlag[]>(ASSIGNMENTS_BAG_KEY);
  if (existing) return existing;
  const fresh: StoredFlag[] = [];
  RequestContext.setBag(ASSIGNMENTS_BAG_KEY, fresh);
  return fresh;
}

/**
 * Assignments recorded this request, for the framework's cookie writer.
 * Empty when nothing was assigned — callers must not re-issue the cookie then.
 */
export function takeExperimentAssignments(): StoredFlag[] {
  return RequestContext.getBag<StoredFlag[]>(ASSIGNMENTS_BAG_KEY) ?? [];
}
