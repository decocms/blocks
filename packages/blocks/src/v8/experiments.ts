/**
 * `@decocms/blocks/experiments`: who is in which A/B test, decided the same
 * way on a server and in a browser.
 *
 * An allocation is content (`{ name: percent }`, a saved block the editor
 * publishes with a release); an assignment is arithmetic. What a visitor gets
 * is never stored as a decision: it is recomputed from the allocation and the
 * visitor's id, so the two sides cannot drift apart. One id serves every
 * experiment, because each roll hashes `name:id`, so a new experiment needs no
 * new state and two experiments are independent.
 *
 * Pure functions: no React, no framework, no module state, no environment
 * reads, no network. Drawing an id is the only impure step, and `assign` takes
 * the randomness as an argument so a test can pin it. Nothing here knows what
 * a CDN or a cache key is: where `assign` runs is the site's call, because
 * only the site knows whether its HTML is served from a cache.
 *
 * The cookie is v7's `deco_segment`, byte for byte (see
 * `@decocms/compat-v7/matchers`), with an `id` field added, so a visitor
 * carried over from v7 keeps the group v7 put them in and analytics keeps
 * reading the cookie it already reads.
 */

/** The experiments block: experiment name to its allocation, 0–100. */
export type Experiments = Record<string, number>;

/** What a visitor got: experiment name to whether they are in it. */
export type Assignments = Record<string, boolean>;

/**
 * A visitor's `deco_segment`. `active`/`inactiveDrawn`/`pct` are v7's fields
 * and analytics reads them; `id` is what every roll is computed from; `exp`
 * holds v7's N-way assignments, which this module only carries over.
 */
export interface Segment {
  /** 16 random bytes as 22 base64url characters, drawn once per visitor. */
  id?: string;
  /** Names this visitor is in. */
  active: string[];
  /** Names this visitor is out of. */
  inactiveDrawn: string[];
  /** The allocation each listed name was last computed under, as an integer. */
  pct: Record<string, number>;
  /** v7's N-way assignments. Never written here, never read; passed through. */
  exp?: Record<string, string>;
}

/** Fills `bytes` with random values. `assign` takes one so tests can pin the id. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void;

/** The cookie holding a visitor's id and decisions (v7's name). */
export const SEGMENT_COOKIE = "deco_segment";

/** One year: the id is the visitor, and it should outlive any single test. */
export const SEGMENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A cookie over this stays out of every request. An id plus 50 experiments
 * fits well under it; past it, `serializeSegment` drops `inactiveDrawn`
 * entries, which the id recomputes anyway.
 */
const COOKIE_BUDGET = 2048;

const ID_BYTES = 16;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

const encoder = new TextEncoder();

/**
 * MurmurHash3 x86 32-bit, seed 0, over `bytes`, as an unsigned 32-bit number.
 *
 * A hash bug here fails silently: every visitor still gets an answer, it is
 * just the wrong one, and the test's result is quietly meaningless. That is
 * why `experiments.test.ts` pins a table of vectors rather than only checking
 * the distribution, and why changing this function is a breaking change.
 */
export function murmur3_32(bytes: Uint8Array, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const len = bytes.length;
  const blocks = len & ~3;
  let h = seed >>> 0;

  for (let i = 0; i < blocks; i += 4) {
    let k =
      ((bytes[i] as number) |
        ((bytes[i + 1] as number) << 8) |
        ((bytes[i + 2] as number) << 16) |
        ((bytes[i + 3] as number) << 24)) >>>
      0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const tail = len & 3;
  if (tail > 0) {
    let k = 0;
    if (tail === 3) k ^= (bytes[blocks + 2] as number) << 16;
    if (tail >= 2) k ^= (bytes[blocks + 1] as number) << 8;
    k ^= bytes[blocks] as number;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * This visitor's number for this experiment: a fixed value in [0, 100) with a
 * step of 0.01, the same on every runtime. The visitor is in when it is below
 * the allocation, which is what makes a ramp only ever add people: the roll
 * does not move, the threshold does.
 */
export function roll(name: string, id: string): number {
  return (murmur3_32(encoder.encode(`${name}:${id}`)) % 10000) / 100;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const defaultRandom: RandomBytes = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** A fresh visitor id: 128 bits as 22 base64url characters. */
export function newId(random: RandomBytes = defaultRandom): string {
  const bytes = new Uint8Array(ID_BYTES);
  random(bytes);
  return toBase64Url(bytes);
}

/** A segment with nothing in it: what a first visit and a broken cookie both give. */
export function emptySegment(): Segment {
  return { active: [], inactiveDrawn: [], pct: {} };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function pctRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [name, pct] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pct === "number" && Number.isFinite(pct)) out[name] = pct;
  }
  return out;
}

function expRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [name, variant] of Object.entries(value as Record<string, unknown>)) {
    if (typeof variant === "string") out[name] = variant;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The raw `deco_segment` value out of a `Cookie` header or `document.cookie`. */
function readCookie(cookies: string): string | undefined {
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SEGMENT_COOKIE) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The visitor's segment out of a `Cookie` header or `document.cookie`.
 *
 * Never throws, for any input. A missing, undecodable or wrongly shaped value
 * gives an empty segment, non-string entries are dropped, and an id that is
 * not 22 base64url characters is treated as absent so `assign` draws a new
 * one. Editing your own cookie only changes your own content, which is why
 * an assignment may never decide a price or a permission.
 */
export function parseSegment(cookies: string | null | undefined): Segment {
  if (!cookies) return emptySegment();
  const raw = readCookie(cookies);
  if (!raw) return emptySegment();
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(raw))) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return emptySegment();
    const segment: Segment = {
      active: stringList(parsed.active),
      inactiveDrawn: stringList(parsed.inactiveDrawn),
      pct: pctRecord(parsed.pct),
    };
    if (typeof parsed.id === "string" && ID_RE.test(parsed.id)) segment.id = parsed.id;
    const exp = expRecord(parsed.exp);
    if (exp) segment.exp = exp;
    return segment;
  } catch {
    return emptySegment();
  }
}

/**
 * The segment as a `deco_segment` value: v7's
 * `btoa(encodeURIComponent(JSON.stringify(...)))`, with a fixed key order and
 * names sorted, so two equal segments give byte-equal cookies and `changed`
 * is the only thing that ever triggers a write.
 */
export function serializeSegment(segment: Segment): string {
  const active = [...segment.active].sort();
  let inactiveDrawn = [...segment.inactiveDrawn].sort();

  const encode = (): string => {
    const pct: Record<string, number> = {};
    for (const name of Object.keys(segment.pct).sort()) {
      if (active.includes(name) || inactiveDrawn.includes(name))
        pct[name] = segment.pct[name] as number;
    }
    const body: Record<string, unknown> = { active, inactiveDrawn, pct };
    if (segment.id !== undefined) body.id = segment.id;
    if (segment.exp !== undefined) body.exp = segment.exp;
    return btoa(encodeURIComponent(JSON.stringify(body)));
  };

  let value = encode();
  // Over budget: drop the experiments the visitor is out of, oldest first.
  // They cost the most and are worth the least — the id recomputes them.
  while (value.length > COOKIE_BUDGET && inactiveDrawn.length > 0) {
    inactiveDrawn = inactiveDrawn.slice(1);
    value = encode();
  }
  return value;
}

/**
 * The `Set-Cookie` line for a segment. Not `HttpOnly`: the browser and the
 * analytics script both read it, which is also why an assignment is only ever
 * allowed to change content.
 *
 * `secure` defaults to `true`; a site serving over plain http (localhost)
 * passes `false`. The package reads no environment, so it cannot tell.
 */
export function segmentCookie(segment: Segment, options: { secure?: boolean } = {}): string {
  const { secure = true } = options;
  const parts = [
    `${SEGMENT_COOKIE}=${serializeSegment(segment)}`,
    "Path=/",
    `Max-Age=${SEGMENT_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** What `assign` answers. */
export interface Assignment {
  /** Every experiment in the block, and whether this visitor is in it. */
  assignments: Assignments;
  /** The segment to write back when `changed`. */
  segment: Segment;
  /** Whether the cookie should be rewritten: a new id, a new decision, or a name dropped. */
  changed: boolean;
}

function roundPct(allocation: number): number {
  if (!Number.isFinite(allocation)) return 0;
  return Math.round(Math.min(100, Math.max(0, allocation)));
}

/**
 * This visitor's answer for every experiment in the block.
 *
 * Pure apart from drawing an id on a first visit, and it never throws for any
 * input. A v7 visitor's stored decision is honoured while the allocation it
 * was drawn at still holds, so the migration itself reshuffles nobody; once
 * an editor moves the allocation, the computed roll takes over. A name that
 * left the block leaves the cookie, and its rules read as `false`.
 *
 * Two early parallel requests on a first visit can draw different ids; the
 * first cookie the browser stores wins from then on. That is the only race,
 * and it costs one visitor one re-draw.
 */
export function assign(
  experiments: Experiments,
  segment?: Segment,
  random: RandomBytes = defaultRandom,
): Assignment {
  const source = segment ?? emptySegment();
  const next: Segment = {
    id: source.id,
    active: [],
    inactiveDrawn: [],
    pct: {},
  };
  if (source.exp !== undefined) next.exp = source.exp;

  let changed = false;

  if (next.id === undefined || !ID_RE.test(next.id)) {
    next.id = newId(random);
    changed = true;
  }

  const names =
    typeof experiments === "object" && experiments !== null ? Object.keys(experiments).sort() : [];

  const assignments: Assignments = {};
  for (const name of names) {
    const allocation = experiments[name];
    if (typeof allocation !== "number" || !Number.isFinite(allocation)) continue;
    const pct = roundPct(allocation);

    const stored = source.active.includes(name)
      ? true
      : source.inactiveDrawn.includes(name)
        ? false
        : undefined;
    // A decision survives only while it was made under today's allocation.
    const value =
      stored !== undefined && source.pct[name] === pct ? stored : roll(name, next.id) < allocation;

    assignments[name] = value;
    (value ? next.active : next.inactiveDrawn).push(name);
    next.pct[name] = pct;
    if (value !== stored || source.pct[name] !== pct) changed = true;
  }

  const kept = new Set(names);
  for (const name of [...source.active, ...source.inactiveDrawn, ...Object.keys(source.pct)]) {
    if (!kept.has(name)) {
      changed = true;
      break;
    }
  }

  return { assignments, segment: next, changed };
}
