/** The payload contract — one definition, imported by the runtime and by the Worker.
 *
 *  It lived in two files with duplicated constants, which is the reliable way to end up
 *  with a client truncating at 200 and a server truncating at 250. The runtime applies
 *  these rules to save bandwidth; the Worker applies them because the endpoint is public
 *  and the client is by definition untrusted. Same rules, different reasons.
 *
 *  Fields deliberately do NOT share one charset. Applying a single rule everywhere is the
 *  mistake: `plp-ranking` is a frozen experiment key owned by another team and contains a
 *  hyphen, and an order id from a customer's OMS is opaque and case-sensitive. Normalising
 *  those would break a join and an invoice respectively.
 */

export const LIMITS = {
  requestBytes: 64 * 1024,
  // What the runtime puts in ONE request, under `requestBytes` with room for the envelope. Also
  // under the browser's 64 KB keepalive/beacon quota, so a final flush is never refused whole.
  batchBytes: 56 * 1024,
  eventsPerBatch: 50,
  eventBytes: 1024,
  errorEventBytes: 8 * 1024,
  // `$heatmap`: one event per page view carrying its clicks, scroll and attention. Measured
  // ~450-500 B for a typical storefront view; the client sheds its newest clicks to stay
  // under 3,800 B, so this is a ceiling the runtime never reaches on its own.
  heatmapEventBytes: 4 * 1024,
  hmClicks: 40, // click records per view (a rage burst is ONE record with a count)
  hmRoots: 32, // root dictionary entries per view
  hmBands: 40, // attention bands, 2.5% of the document each
  hmRootLen: 120, // a root identity: manifest key + ordinal, or fs:<component>#n
  queueMax: 200,

  // GA4's limit. Anything valid there is valid here, so a migration does not hit a new
  // ceiling on arrival.
  nameLen: 40,
  propKeys: 24, // GA4 allows 25
  keyLen: 40,
  valueLen: 200,

  expEntries: 8,
  expKeyLen: 60,
  pathLen: 512,
  refLen: 256,
  itemIds: 20,
  itemIdLen: 64,
  transactionIdLen: 64, // order ids run longer than a prop key
  flushMs: 10_000,
} as const;

/** `_trunc` is `LowCardinality(String)`. A free-text flag would rebuild the cardinality
 *  problem inside the column that exists to detect it, so the vocabulary is closed —
 *  and small, which keeps its dictionary at a handful of entries for the whole fleet. */
/** Flags are namespaced by the field they concern. `value.type` was ambiguous: there is
 *  also a column called `value` holding money, so a reader could not tell whether the flag
 *  meant "a prop was the wrong type" or "the amount would not parse". Now `props.*` is
 *  about the props map and `amount.*` is about money.
 *
 *  The four the client needs are exported individually as well as in the map below.
 *  esbuild cannot tree-shake a single property off an object it sees referenced, so
 *  `FLAGS.propsCount` drags all twenty-one strings into the browser bundle. Naming them
 *  separately keeps the client at the four it uses. */
export const F_PROPS_COUNT = "props.count";
export const F_PROPS_TYPE = "props.type";
export const F_PROPS_LEN = "props.len";
export const F_QUEUE_OVERFLOW = "queue.overflow";
/** More events arrived in one request than `eventsPerBatch` allows. The surplus is discarded
 *  and the survivors carry this, so the loss is visible in the warehouse rather than inferred
 *  from a gap — the same contract `queue.overflow` makes on the client. */
export const F_BATCH_OVERFLOW = "batch.overflow";

export const FLAGS = {
  nameEmpty: "name.empty",
  nameCharset: "name.charset",
  nameLen: "name.len",
  nameReserved: "name.reserved",
  keyCharset: "key.charset",
  keyLen: "key.len",
  propsCount: F_PROPS_COUNT,
  propsType: F_PROPS_TYPE,
  propsLen: F_PROPS_LEN,
  propsControl: "props.control",
  expCount: "exp.count",
  expCharset: "exp.charset",
  currencyInvalid: "currency.invalid",
  amountType: "amount.type",
  pathLen: "path.len",
  refLen: "referrer.len",
  itemIdsCount: "item_ids.count",
  tsSkew: "ts.skew",
  queueOverflow: F_QUEUE_OVERFLOW,
  eventSize: "event.size",
  // The sender's id was absent or not a UUID, so the Worker minted one. Recorded rather
  // than silent because it costs the event its only dedup key: `uniqExact(event_id)` can
  // no longer collapse a retry of the same event, and a number that quietly counts a
  // retry twice is worse than one that says why.
  eventIdMinted: "event_id.minted",
  // Tier 0 identity for this row was built from a DERIVED salt because the day's stored one was
  // missing — a cron that did not run. Derived from YESTERDAY's random salt, not from any
  // secret, so the day is recomputable only until that salt expires from KV (around 03:10 UTC
  // the following day), and then by nobody. Recorded rather than silent: "which days were recomputable,
  // and for how long" has to be answerable from the warehouse. Rows written before 2026-10-27
  // carry the same flag for a salt derived from `SALT_SECRET`/`VISITOR_SECRET`.
  saltDerived: "salt.derived",
  // Neither today's nor yesterday's salt was in KV, so this isolate minted a random salt for
  // the day and holds it only in memory. Unrecomputable by anyone, and that costs counting:
  // a visitor whose requests reach two isolates is two visitor_ids that day. Recorded so a
  // fragmented day's unique counts are known to be inflated rather than trusted.
  saltEphemeral: "salt.ephemeral",
  // A tier 1 site sent a consented client id and there was no VISITOR_SECRET to hash it with,
  // so this row fell back to tier 0 identity. Recorded because the failure is otherwise
  // INVISIBLE AND EXPENSIVE: the site keeps collecting, every number looks right, and the one
  // thing consent was collected to enable -- following the same person across days -- silently
  // does not happen. The remedy is a deploy, so it has to be findable in the warehouse.
  consentNoSecret: "consent.no_secret",
  // DEPRECATED, never stamped any more. It meant "`SALT_SECRET` is unset, so tier 0's fallback
  // would derive from `VISITOR_SECRET`". Tier 0 no longer has a secret at all (#13), so the
  // state it described cannot exist. Declared still because rows written before 2026-10-27
  // carry it, and this is where the `_trunc` vocabulary is closed.
  saltSecretUnsplit: "salt.unsplit",
  originMismatch: "origin.mismatch",
  // An event or a prop key the site never declared. Recorded, never rejected: a taxonomy
  // that drops data punishes the analyst for the developer's mistake, and the whole
  // point of a registry is to make drift VISIBLE, not to lose the drifted data.
  nameUnregistered: "name.unregistered",
  propsUnregistered: "props.unregistered",
  // The only two flags no collected event ever carries: they are written by `ops/backfill.mjs`
  // on rows imported from the vendor we are replacing, and the Worker never sets them.
  //
  // They live here anyway, because this is where the `_trunc` vocabulary is CLOSED. A value in
  // that column that is not declared here is off-contract, and the reason the vocabulary is
  // closed at all -- keeping a LowCardinality dictionary at a handful of entries -- does not
  // care which process wrote the row.
  //
  // `import.vendor` is provenance. `site_id_source = 'import'` already says a row was not
  // collected; it does not say by whom, and the day a second vendor or a customer CSV arrives,
  // "not host and not tag" identifies nothing.
  //
  // `import.day_grain` is a warning about the row's TIME. The vendor cannot report hours --
  // `time:hour` collapses to a single bucket on their side -- so every imported event of a day
  // sits at 00:00 of that day, and any hourly panel over an imported window is a midnight spike
  // and nothing else. We do not synthesise a diurnal curve to make that chart look reasonable:
  // an invented shape is worse than an absent one, because only the absent one is discoverable.
  // This flag is how it is discovered.
  //
  // NEITHER IS A TRUST BOUNDARY. `flagSink` carries a payload's prior `_trunc` through without
  // checking it against this list, so any browser can post either string -- as it already could
  // before they were named here. The mark billing reads is `site_id_source`, which the Worker
  // resolves and the payload cannot influence. These two are for a human reading a row.
  // `$heatmap` only. `hm.len`: an array or a value was capped to its LIMITS bound. `hm.shape`:
  // something was the wrong type or out of range and was DROPPED -- a click with no valid anchor
  // hash, a section index pointing nowhere, a missing view id. Two flags rather than one per
  // field, for the reason the vocabulary is closed at all.
  hmLen: "hm.len",
  hmShape: "hm.shape",
  // `edge_events` only. The store's Worker called `EdgeIngest.write` without a bot score, so the
  // row carries 99, the same "unknown, keep it" default a request without `cf.botManagement`
  // gets on `workers.dev`. Marked because an RPC call carries no `request.cf` of its own: the
  // score exists only if the caller forwarded it, and a funnel with bots quietly left in has to
  // be findable.
  edgeNoBotScore: "edge.no_bot_score",
  importVendor: "import.vendor",
  importDayGrain: "import.day_grain",
} as const;

export type Flag = (typeof FLAGS)[keyof typeof FLAGS];
export type Primitive = string | number | boolean;
export type Props = Record<string, Primitive>;

/** Platform events. Anything else arriving with a `$` is a site reaching into a namespace
 *  that is not its own: the prefix is stripped and the attempt recorded. */
/** Platform events. Anything else arriving with a `$` is a site reaching into a namespace
 *  that is not its own: the prefix is stripped and the attempt recorded.
 *
 *  The engagement four are reserved for the same reason as the rest — they are generated
 *  by our module, not by the site, so a registry must not ask a site to declare them and
 *  a site must not be able to forge them. */
export const RESERVED_NAMES = [
  "$pageview",
  "$error",
  "$vitals",
  "$exposure",
  "$scroll",
  "$outbound",
  "$download",
  "$search",
  // One per sampled page view, from the heatmap module. Reserved for the same two reasons as
  // the engagement four, and the second matters more here: sampling is decided per VIEW by the
  // module (`heatmapRate`), so the per-event valve must never touch it.
  "$heatmap",
] as const;

/** Whether the sampling valve is allowed to drop this event.
 *
 *  Sampling used to apply to EVERYTHING, `$pageview` included, and that is not what anyone
 *  else does: GA4 samples in the REPORT when a query exceeds its quota, never at
 *  collection, and Plausible does not sample at all. Dropping pageviews also produced the
 *  worst possible arithmetic — a visitor with k events survives a rate r with probability
 *  1-(1-r)^k, so a nominal 10% sample kept ~50% of visitors while keeping exactly 10% of
 *  events, a five-fold overcount of uniques.
 *
 *  The collector's own `$` events are exempt, and that dissolves the problem rather than
 *  mitigating it: every visit carries a `$pageview`, so if pageviews never drop then
 *  visitor counts are exact at any rate. They are also bounded per pageview by
 *  construction — one pageview, one vitals, one scroll, errors already collapsed into
 *  `error_count` — so exempting them sheds almost no volume.
 *
 *  What floods a site is custom events: `track()` in a render loop is the emergency this
 *  valve exists for, and it is the only thing the valve now touches. */
export function isSampleable(name: string): boolean {
  return !name.startsWith("$");
}

/** What the store's own Worker may write through `EdgeIngest`, and the props each one carries.
 *
 *  A CLOSED vocabulary, unlike the tag's. The edge is ours: these are the requests a store
 *  Worker sees on both sides of a Fresh x TanStack split, emitted by one wrapper rather than by
 *  each site's code, and that sameness is the whole reason they can be a ruler for an A/B test
 *  between two codebases. A name outside this list is refused and counted; a prop outside it is
 *  kept and flagged `props.unregistered`, like the site registry does.
 *
 *  They land in `edge_events`, never in `raw_events` (D20), so no panel, rollup or session
 *  built on the tag ever counts a checkout API call as a page view. */
export const EDGE_EVENTS = {
  /** One per HTML document, on both sides of the split. `og` is the orderGroup on the order
   *  confirmation (`/checkout/orderPlaced?og=`): it links a VTEX order to the visit that saw it.
   *  `sc` is the sales channel of the request; `cart` the hashed orderForm on checkout documents. */
  $edge_page: ["page", "status", "prefetch", "cache", "ttfb_ms", "og", "sc", "cart", "fetch_site"],
  /** One per call to the VTEX checkout API. `step` includes `gatewayCallback`. The cart shape
   *  (`qty` .. `items_value`, `payment`, `coupon`) is read from the orderForm that `shippingData`
   *  and `paymentData` return; `error` is the VTEX code and message on a status >= 400. */
  checkout_step: [
    "step",
    "status",
    "cart",
    "payment",
    "coupon",
    "shipping_paid",
    "items",
    "referer",
    "error",
    "ms",
    "from_checkout",
    "qty",
    "lines",
    "sellers",
    "packages",
    "shipping",
    "items_value",
  ],
  /** One per call that changes the cart outside the checkout: `add`, `remove`, `update`,
   *  `coupon`, `simulate`. The route differs per side (v7's invoke route on Fresh, the TanStack
   *  invoke route), and the store Worker maps both to this. */
  cart_action: ["action", "status", "cart", "items"],
  /** What the shopper is paying and why, beside `checkout_step` on `shippingData` and
   *  `paymentData`: discounts, promotions, the orderForm's messages, unavailable items, gifts,
   *  who VTEX thinks the shopper is, and what the payment POST asked for. */
  checkout_summary: [
    "step",
    "status",
    "cart",
    "value",
    "items_value",
    "discounts",
    "shipping",
    "qty",
    "lines",
    "promos",
    "promo_hash",
    "promo_names",
    "messages",
    "message_count",
    "unavailable",
    "selectable_gifts",
    "gift_items",
    "priced_items",
    "utm_source",
    "coupon",
    "tags",
    "channels",
    "pay_systems",
    "installments",
    "pay_value",
    "logged_in",
    "can_edit",
    "email",
    "profile_id",
    "saved_cards",
    "saved_addresses",
    "cookies",
  ],
  /** The checkout page's own beacon, forwarded by the store Worker: JS errors, the step the
   *  shopper is on, the click on "place order" (`kind = buy`) and what followed it, the messages
   *  on screen, the exit. `kind` is the beacon's, `msg`/`aux`/`n` its three fields. */
  checkout_js: ["kind", "msg", "aux", "n", "cart"],
} as const satisfies Record<string, readonly string[]>;

export type EdgeEventName = keyof typeof EDGE_EVENTS;
/** Props per edge event. Above the tag's `propKeys` because the vocabulary is closed and ours:
 *  `checkout_summary` carries 32 fields, and packing them into fewer keys would trade a query on
 *  a column for a parse of a string. */
export const EDGE_PROP_KEYS = 40;
/** Size budget per edge event, for the same reason: the tag's 1 KB is a budget for a visitor's
 *  upload on mobile data, and an edge event never travels over one. */
export const EDGE_EVENT_BYTES = 4096;
export const EDGE_EVENT_NAMES = Object.keys(EDGE_EVENTS) as EdgeEventName[];

/** The side of a Fresh x TanStack split, as an experiment.
 *
 *  `withABTesting` (decocms/blocks, compat-v7) keeps the side in the `_deco_bucket` cookie as
 *  `<side>:<percent>`. The runtime's deco adapter reads it into `exp`, and the store Worker
 *  stamps the same pair on what it sends through `EdgeIngest`, so both halves of the funnel
 *  group by one experiment with one pair of variant names. Changing a value here without
 *  changing the store side splits the funnel in two. */
export const STOREFRONT_EXP = {
  cookie: "_deco_bucket",
  name: "storefront",
  variants: { worker: "tanstack", fallback: "fresh" } as Record<string, string>,
} as const;

/** The campaign parameters worth a typed column, and nothing else. `utm` is a Map with
 *  LowCardinality keys: an open vocabulary is exactly how that becomes a cardinality
 *  problem, since anything appending `utm_<random>` to a URL would mint a key forever.
 *  The five UTM parameters are the standard set; `gclid` and `fbclid` are here because
 *  they are what actually arrives from paid traffic and are otherwise lost. */
export const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

/** Strip the `utm_` prefix on the way in: the column is already called `utm`, so storing
 *  `utm_source` spends five characters per row per key restating it. */
export const campaignKey = (raw: string): string | null => {
  const k = raw.trim().toLowerCase();
  // Accepts BOTH the raw form and the already-stripped one, because this runs twice:
  // once in the browser reading the query string, and again in the Worker over whatever
  // arrived. Accepting only `utm_source` meant the Worker dropped everything the runtime
  // had correctly shortened to `source`, and only `gclid` survived — it has no prefix to
  // strip. The endpoint is public anyway, so it has to handle either shape regardless of
  // what our own runtime happens to send.
  if ((CAMPAIGN_KEYS as readonly string[]).includes(k)) {
    return k.startsWith("utm_") ? k.slice(4) : k;
  }
  return (CAMPAIGN_KEYS as readonly string[]).includes("utm_" + k) ? k : null;
};

/** Short keys on the wire, full names in the column. At 452M events a month, field names
 *  are a double-digit percentage of a 293-byte event — and the browser pays that upload on
 *  mobile data. Plausible does the same for the same reason. The Worker expands them, so
 *  nothing downstream ever sees the abbreviation. */
/** What a minted self-serve key looks like: a prefix and 22 URL-safe characters, the same
 *  shape the visitor hash uses.
 *
 *  It lives in the CONTRACT rather than in the Worker's config module because it is one:
 *  whoever mints keys and whoever reads them have to agree, and those will not be the same
 *  codebase (D9). Deliberately NOT a secret — Plausible puts the equivalent in the script's
 *  filename, OneDollarStats uses the hostname itself, and a public identifier is the only
 *  thing a browser tag can carry. That is exactly why a key-sourced site is recorded as
 *  `tag` and never billed from. Checking the shape is a BOUND, not authentication: without
 *  it, any string of any length from any visitor becomes a KV read we pay for. */
export const KEY_SHAPE = /^dq_[A-Za-z0-9_-]{22}$/;

export const WIRE = {
  event_id: "i",
  /** A stable per-browser identifier, present ONLY on a tier-1 site whose visitor has
   *  granted consent. Absent otherwise, which is the whole point: at tier 0 there is
   *  nothing to send, and the Worker derives identity from a salt it rotates and forgets
   *  daily. Never stored as sent — the Worker hashes it with the site so the same browser
   *  is a different identifier on every customer's site. */
  client_id: "ci",
  ts: "t",
  name: "n",
  path: "p",
  referrer: "r",
  exp: "x",
  props: "d",
  value: "v",
  currency: "c",
  items_count: "q",
  item_ids: "s",
  transaction_id: "o",
  error_type: "et",
  error_message: "em",
  error_file: "ef",
  error_line: "el",
  error_stack: "es",
  error_fingerprint: "eg",
  error_count: "ec",
  utm: "u",
  // Core Web Vitals go in typed columns rather than props: they are numbers that get
  // averaged, bucketed and compared against thresholds, and a Map value would have to be
  // parsed on every read. Nullable, because a metric that never fired must be absent
  // rather than zero — a page nobody interacted with has no INP, and recording 0 would
  // put it in the "good" bucket.
  vital_lcp: "vl",
  vital_inp: "vi",
  vital_cls: "vc",
  vital_ttfb: "vt",
  vital_fcp: "vf",
  // The heatmap module's per-view object. Expanded by the Worker into typed `hm_*` columns,
  // never stored as sent. Shape in docs/PAYLOAD_CONTRACT.md.
  heatmap: "hm",
  _trunc: "_",
} as const;

const KEY_OK = /^[a-z][a-z0-9_]*$/;
const EXP_OK = /^[a-z0-9][a-z0-9_-]*$/; // hyphens: `plp-ranking`, `model-b`
const CONTROL = /[\x00-\x1F\x7F]/g;
const ISO4217 = /^[A-Z]{3}$/;

export type Sink = (f: Flag) => void;

/** snake_case, letter-initial, no spaces. The name becomes a panel label and a grouping
 *  key, so case and punctuation fragment one event across variants of itself — and a
 *  fragmented name also inflates the `LowCardinality` dictionary it lives in.
 *
 *  Normalising is right. Doing it silently is not: two names collapsing into one is
 *  something the sender has to be able to see. */
export function normalizeName(
  input: unknown,
  flag: Sink,
  reserved: readonly string[] = RESERVED_NAMES,
): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    flag(FLAGS.nameEmpty);
    return "unnamed";
  }

  if (raw.startsWith("$")) {
    if (reserved.includes(raw)) return raw;
    flag(FLAGS.nameReserved);
    return normalizeName(raw.slice(1), flag, reserved);
  }

  let n = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) {
    flag(FLAGS.nameEmpty);
    return "unnamed";
  }
  if (!/^[a-z]/.test(n)) n = "e_" + n;
  if (n !== raw) flag(FLAGS.nameCharset);
  if (n.length > LIMITS.nameLen) {
    n = n.slice(0, LIMITS.nameLen).replace(/_+$/, "");
    flag(FLAGS.nameLen);
  }
  return n;
}

function normalizeKey(input: string, flag: Sink): string | null {
  let k = input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!k) return null;
  if (!/^[a-z]/.test(k)) k = "p_" + k;
  if (k !== input) flag(FLAGS.keyCharset);
  if (k.length > LIMITS.keyLen) {
    k = k.slice(0, LIMITS.keyLen).replace(/_+$/, "");
    flag(FLAGS.keyLen);
  }
  return KEY_OK.test(k) ? k : null;
}

/** Control characters are replaced rather than truncated around: a newline inside a value
 *  breaks line-oriented reads of the same data downstream, and a tab breaks TSV. */
export function normalizeProps(
  input: unknown,
  flag: Sink,
  maxKeys: number = LIMITS.propKeys,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;

  let n = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (n >= maxKeys) {
      flag(FLAGS.propsCount);
      break;
    }
    if (rawValue === null || rawValue === undefined) continue;

    const t = typeof rawValue;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      flag(FLAGS.propsType);
      continue;
    }

    const key = normalizeKey(rawKey, flag);
    if (!key) {
      flag(FLAGS.keyCharset);
      continue;
    }

    let v = String(rawValue);
    const stripped = v.replace(CONTROL, " ");
    if (stripped !== v) {
      v = stripped;
      flag(FLAGS.propsControl);
    }
    if (v.length > LIMITS.valueLen) {
      v = v.slice(0, LIMITS.valueLen);
      flag(FLAGS.propsLen);
    }

    out[key] = v;
    n++;
  }
  return out;
}

/** Case and hyphens preserved: these keys are a frozen contract owned elsewhere, and
 *  rewriting `plp-ranking` into `plp_ranking` would silently break the join they exist
 *  for. Invalid keys are dropped rather than coerced, for the same reason. */
export function normalizeExp(input: unknown, flag: Sink): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;

  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= LIMITS.expEntries) {
      flag(FLAGS.expCount);
      break;
    }
    const key = String(k).slice(0, LIMITS.expKeyLen);
    const val = String(v ?? "").slice(0, LIMITS.expKeyLen);
    if (!EXP_OK.test(key) || !EXP_OK.test(val)) {
      flag(FLAGS.expCharset);
      continue;
    }
    out[key] = val;
    n++;
  }
  return out;
}

/** ISO 4217, three letters. Anything else is emptied and flagged: a half-valid currency on
 *  a revenue row is worse than a missing one. */
export function normalizeCurrency(input: unknown, flag: Sink): string {
  const c = String(input ?? "")
    .trim()
    .toUpperCase();
  if (!c) return "";
  if (!ISO4217.test(c)) {
    flag(FLAGS.currencyInvalid);
    return "";
  }
  return c;
}

/** Unparseable becomes null and is flagged, never coerced to zero. A silent zero in a
 *  revenue report is a wrong number; a null is a missing one, and only one of those gets
 *  noticed. */
export function normalizeAmount(input: unknown, flag: Sink): number | null {
  if (input === null || input === undefined || input === "") return null;
  const n = Number(input);
  if (!Number.isFinite(n)) {
    flag(FLAGS.amountType);
    return null;
  }
  return n;
}

/** Opaque and case-sensitive: it comes from the customer's order system, and it is what
 *  stops a reloaded confirmation page counting a sale twice. Only control bytes go. */
/** Canonical UUID form, which is what the `event_id` column accepts. Not a version check:
 *  a v4 from the runtime, a v7 from a server-side sender and a caller's own id are all
 *  fine, and refusing one of them would be inventing a contract nobody agreed to. */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** An id that ClickHouse will accept, minted when the sender did not supply a usable one.
 *
 *  This closes a hole that cost whole batches. `event_id` is a `UUID` column, and an absent
 *  id normalised to `""` -- which fails to parse, and a JSONEachRow INSERT fails as ONE
 *  statement. So a single event without an id destroyed every event in the same request,
 *  the sender got its 204, and the only trace was `events_lost`. Measured: one event with
 *  no `i` field, ClickHouse code 27, `inserted: 0`, `eventsLost: 1`.
 *
 *  Our own runtime always sends one, which is exactly why this went unnoticed -- but the
 *  endpoint is public, and a server-side sender or a third-party SDK writing the lean
 *  version of our contract is not a hypothetical. `sanitize.ts` promises never to "reject a
 *  batch because one event is bad", and this is the one place it silently did. */
export function normalizeEventId(input: unknown, flag: Sink): string {
  const v = normalizeOpaque(input, 36);
  if (UUID_SHAPE.test(v)) return v;
  flag(FLAGS.eventIdMinted);
  return crypto.randomUUID();
}

export function normalizeOpaque(input: unknown, max: number): string {
  return String(input ?? "")
    .replace(CONTROL, "")
    .slice(0, max);
}

export function normalizeItemIds(input: unknown, flag: Sink): string[] {
  if (!Array.isArray(input)) return [];
  if (input.length > LIMITS.itemIds) flag(FLAGS.itemIdsCount);
  return input
    .slice(0, LIMITS.itemIds)
    .map((v) => normalizeOpaque(v, LIMITS.itemIdLen))
    .filter(Boolean);
}

/** ClickHouse `DateTime64` in JSONEachRow wants `YYYY-MM-DD hh:mm:ss.mmm` — a `T` or a `Z`
 *  is a parse error, and a parse error rejects the whole batch rather than the row.
 *  Client clocks are wrong often enough that anything more than a day out is treated as
 *  skew and replaced, so one bad clock cannot poison a partition. */
/** The window is ASYMMETRIC, and that is the whole point.
 *
 *  A timestamp in the past is ordinary: a beacon queued while the visitor was offline, a
 *  tab restored hours later, a phone that reconnects on the train. Up to a day of that is
 *  legitimate and gets kept.
 *
 *  A timestamp in the FUTURE never is. An event cannot be received before it happened, so
 *  a future ts is always a wrong client clock — and browser clocks are wrong constantly.
 *  Accepting them symmetrically, as this did, means a visitor whose clock is twenty
 *  minutes fast pins their events to the top of the realtime feed and inflates "visitors
 *  now" until the world catches up. One skewed device could make the live view useless.
 *
 *  Sixty seconds of forward tolerance covers ordinary jitter between the client's clock
 *  and ours; past that the event is stamped with receipt time and flagged, because the
 *  ORDER of a visitor's events is still worth preserving even when their clock is not.
 */
const PAST_TOLERANCE_MS = 86_400_000; // a day
const FUTURE_TOLERANCE_MS = 60_000; // clock jitter, nothing more

export function normalizeTs(input: unknown, flag: Sink): string {
  const now = Date.now();
  const t = Date.parse(String(input ?? ""));
  if (!Number.isFinite(t) || now - t > PAST_TOLERANCE_MS || t - now > FUTURE_TOLERANCE_MS) {
    flag(FLAGS.tsSkew);
    return new Date(now).toISOString().replace("T", " ").replace("Z", "");
  }
  return new Date(t).toISOString().replace("T", " ").replace("Z", "");
}

/** Deduped and sorted, so two events that hit the same limits produce a byte-identical
 *  array — which is what lets the column compress instead of merely storing. */
export function flagSink(initial: readonly string[] = []) {
  const set = new Set<string>(initial);
  return {
    flag: ((f: Flag) => {
      set.add(f);
    }) as Sink,
    list: (): string[] => [...set].sort(),
  };
}

/** The config fields the SERVED BUNDLE is built from — and nothing else.
 *
 *  Purging on every config write would throw away the fleet's cache for changes that do not move
 *  a single byte of the script. `domains` is only ever read server-side, to cross-check an Origin
 *  against a declared key; `schema` drives validation in the Worker; `goals` belongs to the read
 *  side. None of them reach the browser.
 *
 *  Kept here, next to the wire contract, because it is exactly that: a promise about what the
 *  bundle depends on. When `serveScript` starts reading another field, it goes in this list, and
 *  the test that compares the two catches it if it does not. */
export const BUNDLE_FIELDS = [
  "id",
  "sampling",
  "tier",
  "hash",
  "modules",
  "heatmapRate",
  "errorHosts",
] as const;

/** A stable fingerprint of just those fields, for deciding whether a write needs a purge.
 *  Key order is fixed rather than whatever `JSON.stringify` produces from an object literal,
 *  since two configs equal in content must not differ here by the order someone typed them. */
export function bundleFingerprint(cfg: Record<string, unknown> | null | undefined): string {
  if (!cfg) return "";
  return JSON.stringify(
    BUNDLE_FIELDS.map((f) => {
      const v = cfg[f];
      // Module ORDER does not change the bundle -- they are concatenated from a fixed map -- so
      // a reorder must not look like a change.
      return Array.isArray(v) ? [...v].map(String).sort() : (v ?? null);
    }),
  );
}
