/**
 * `@decocms/blocks/experiments`: who is in which A/B test, decided the same
 * way on a server, in a browser and in a mobile app.
 *
 * The percentages are content (the saved block `experiments`, of the built-in
 * type `split-traffic`); a decision is arithmetic over the visitor's id. What
 * a visitor gets is never stored: it is recomputed from the percentage and the
 * id, so one id serves every test (each roll hashes `name:id`), a new test
 * needs no new state and two tests are independent.
 *
 * Pure functions over values and strings: no React, no framework, no module
 * state, no environment reads, no network. Nothing here is called for you:
 * the app reads the visitor its own way (`readVisitor` on the web, device
 * storage in an app) and hands it to `cms.client({ visitor })`; the built-in
 * `split-traffic` calls `assign` with it.
 *
 * The stored form is v7's `deco_segment` (the same fields and encoding; names
 * sorted by code unit rather than v7's `localeCompare`) plus an `id`, so a
 * visitor carried over from v7 keeps the group v7 put them in and analytics
 * keeps reading the cookie it already reads. A visitor is written once, when
 * it has no id; v7's stored decisions are read and honoured, never rewritten.
 */

import { newId, roll } from "./bucketing.ts";

/** The saved block `experiments`: each test's name and the whole percentage of visitors in it, 0–100. */
export type Experiments = Record<string, number>;

/** What a visitor got: each test's name and whether they are in it. */
export type Assignments = Record<string, boolean>;

/**
 * Who is visiting: an id every decision is computed from, plus the decisions
 * v7 stored (`active`, `inactiveDrawn`, `pct`, `exp`), which are honoured and
 * carried, never rewritten.
 */
export interface Visitor {
  /** 16 random bytes as 22 base64url characters, drawn once per visitor. */
  id: string;
  /** Tests v7 put this visitor in. */
  active: string[];
  /** Tests v7 left this visitor out of. */
  inactiveDrawn: string[];
  /** The percentage each of v7's decisions was made at. */
  pct: Record<string, number>;
  /** v7's N-way decisions. Never read; carried as they are. */
  exp?: Record<string, string>;
}

/** What `readVisitor` answers. */
export interface VisitorFromRequest {
  /** The request's visitor, or a new one when it had none. */
  visitor: Visitor;
  /**
   * The `Set-Cookie` line to send when the visitor had no id (a first visit,
   * or a v7 visitor getting theirs); `null` otherwise. Never send it from a
   * preview.
   */
  cookie: string | null;
}

/** The fields of a request `readVisitor` reads: a `Request`, or anything with its `headers`. */
interface RequestWithHeaders {
  url?: string;
  headers: { get(name: string): string | null };
}

/** The visitor's stored form, v7's name for it. */
const VISITOR_COOKIE = "deco_segment";

/** One year: the id is the visitor, and it should outlive any single test. */
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A cookie over this stays out of every request. An id plus 50 of v7's
 * decisions fits well under it; past it, `serializeVisitor` drops entries,
 * the ones the id reproduces first.
 */
const COOKIE_BUDGET = 2048;

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A stored visitor before it is known to have an id. */
type Stored = Omit<Visitor, "id"> & { id?: string };

/**
 * A record with no prototype, so a name such as `__proto__` is an ordinary
 * key: decided, written and read back like any other.
 */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyStored(): Stored {
  return { active: [], inactiveDrawn: [], pct: record() };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function pctRecord(value: unknown): Record<string, number> {
  const out = record<number>();
  if (typeof value !== "object" || value === null) return out;
  for (const [name, pct] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pct === "number" && Number.isFinite(pct)) out[name] = pct;
  }
  return out;
}

function expRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out = record<string>();
  for (const [name, variant] of Object.entries(value as Record<string, unknown>)) {
    if (typeof variant === "string") out[name] = variant;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A stored value, with or without an id; `null` when it doesn't read. Never
 * throws. The value may arrive percent-encoded (some cookie APIs encode what
 * they write; base64 never holds a `%`, so decoding first is always safe).
 * Entries of the wrong type are dropped, and an id that is not 22 base64url
 * characters is treated as absent.
 */
function parseStored(text: string | null | undefined): Stored | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(decodeURIComponent(text.trim()))));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    const stored: Stored = {
      active: stringList(body.active),
      inactiveDrawn: stringList(body.inactiveDrawn),
      pct: pctRecord(body.pct),
    };
    if (typeof body.id === "string" && ID_RE.test(body.id)) stored.id = body.id;
    const exp = expRecord(body.exp);
    if (exp) stored.exp = exp;
    return stored;
  } catch {
    return null;
  }
}

/** A new visitor: a fresh id and nothing else. */
export function newVisitor(): Visitor {
  return { id: newId(), active: [], inactiveDrawn: [], pct: record() };
}

/**
 * A visitor out of its stored form (what `serializeVisitor` wrote, the value
 * of the `deco_segment` cookie). `null` when the text is missing, doesn't
 * read, or holds no id (a v7 value: `readVisitor` gives it one, keeping its
 * decisions). Never throws.
 */
export function parseVisitor(text: string | null | undefined): Visitor | null {
  const stored = parseStored(text);
  return stored?.id === undefined ? null : (stored as Visitor);
}

/**
 * The visitor's stored form: v7's `btoa(encodeURIComponent(JSON.stringify(...)))`,
 * with a fixed key order and names sorted, so two equal visitors give
 * byte-equal values. Under 2KB: past it, v7's entries are dropped, first the
 * ones the id reproduces anyway.
 */
export function serializeVisitor(visitor: Visitor): string {
  const active = [...visitor.active].sort();
  const inactiveDrawn = [...visitor.inactiveDrawn].sort();
  const dropped = new Set<string>();

  const encode = (): string => {
    const stillActive = active.filter((name) => !dropped.has(name));
    const stillInactive = inactiveDrawn.filter((name) => !dropped.has(name));
    const pct = record<number>();
    for (const name of Object.keys(visitor.pct).sort()) {
      // v7 kept a `pct` beside its N-way names too, and `exp` is carried
      // untouched, so their fingerprint is carried with it.
      const listed =
        stillActive.includes(name) ||
        stillInactive.includes(name) ||
        (visitor.exp !== undefined && Object.hasOwn(visitor.exp, name));
      if (listed) pct[name] = visitor.pct[name] as number;
    }
    const body: Record<string, unknown> = {
      active: stillActive,
      inactiveDrawn: stillInactive,
      pct,
    };
    if (visitor.id !== undefined) body.id = visitor.id;
    if (visitor.exp !== undefined) body.exp = visitor.exp;
    return btoa(encodeURIComponent(JSON.stringify(body)));
  };

  let value = encode();
  if (value.length <= COOKIE_BUDGET) return value;

  // Over budget. A dropped entry is decided by the roll from then on, which
  // keeps the decision only when the stored one already agrees with the roll.
  // So drop those first, and the others only if the value is still too big.
  const reproducible = (name: string): boolean => {
    const pct = visitor.pct[name];
    if (typeof pct !== "number") return false;
    return active.includes(name) === roll(name, visitor.id) < pct;
  };
  for (const name of [
    ...inactiveDrawn.filter(reproducible),
    ...active.filter(reproducible),
    ...inactiveDrawn.filter((name) => !reproducible(name)),
    ...active.filter((name) => !reproducible(name)),
  ]) {
    if (value.length <= COOKIE_BUDGET) break;
    dropped.add(name);
    value = encode();
  }
  return value;
}

/** The raw `deco_segment` value out of a `Cookie` header. */
function readCookie(cookies: string | null): string | undefined {
  if (!cookies) return undefined;
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== VISITOR_COOKIE) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether a request came over plain http (localhost), where a `Secure` cookie isn't stored. */
function isPlainHttp(url: string | undefined): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The web helper: the visitor out of a request's `deco_segment` cookie, and
 * the `Set-Cookie` line to send back when it had no id (a first visit, or a
 * v7 visitor, whose decisions are kept). The cookie isn't `HttpOnly` (the
 * analytics script reads it, as in v7) and is `Secure` unless the request
 * came over plain http. Never throws.
 */
export function readVisitor(request: RequestWithHeaders): VisitorFromRequest {
  let header: string | null = null;
  try {
    header = request.headers.get("cookie");
  } catch {
    header = null;
  }
  const stored = parseStored(readCookie(header));
  if (stored?.id !== undefined) return { visitor: stored as Visitor, cookie: null };
  const visitor: Visitor = { ...(stored ?? emptyStored()), id: newId() };
  const parts = [
    `${VISITOR_COOKIE}=${serializeVisitor(visitor)}`,
    "Path=/",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ];
  if (!isPlainHttp(request.url)) parts.push("Secure");
  return { visitor, cookie: parts.join("; ") };
}

function roundPct(allocation: number): number {
  return Math.round(Math.min(100, Math.max(0, allocation)));
}

/**
 * A v7 decision after the percentage moved: raising a percentage never
 * removes anyone v7 put in, and lowering it never adds anyone v7 left out.
 * Otherwise the roll decides, as for any visitor.
 */
function keptFromV7(stored: boolean, from: number, to: number): boolean | undefined {
  if (to === from) return stored;
  if (stored && to > from) return true;
  if (!stored && to < from) return false;
  return undefined;
}

/**
 * This visitor's answer for every test: `true` when they are in it.
 *
 * A visitor is in a test when their roll for it (a fixed number in [0, 100)
 * from the test's name and their id) is under its percentage, so 0 puts
 * nobody in, 100 everybody, and raising a percentage only adds people. A
 * fractional percentage is rounded. A decision v7 stored is honoured while
 * the percentage it was made at holds (a missing or `-1` percentage, v7's
 * "any", included); once it moves, a v7 visitor in a test that grows stays
 * in and one out of a test that shrinks stays out. Without a visitor every
 * test is `false`. Entries that aren't finite numbers are left out. Pure;
 * never throws.
 */
export function assign(
  experiments: Experiments | null | undefined,
  visitor: Visitor | null | undefined,
): Assignments {
  const assignments = record<boolean>();
  if (typeof experiments !== "object" || experiments === null) return assignments;
  const id = visitor !== null && typeof visitor === "object" ? visitor.id : undefined;
  const known = typeof id === "string" && ID_RE.test(id);
  for (const name of Object.keys(experiments).sort()) {
    const allocation = experiments[name];
    if (typeof allocation !== "number" || !Number.isFinite(allocation)) continue;
    if (!known) {
      assignments[name] = false;
      continue;
    }
    const pct = roundPct(allocation);
    const v = visitor as Visitor;
    const stored = list(v.active).includes(name)
      ? true
      : list(v.inactiveDrawn).includes(name)
        ? false
        : undefined;
    // v7 wrote `round(traffic * 100)` here, and its own reader treated a
    // missing or negative entry as "matches anything".
    const raw = isRecord(v.pct) && Object.hasOwn(v.pct, name) ? v.pct[name] : undefined;
    const from = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? roundPct(raw) : pct;
    const kept = stored === undefined ? undefined : keptFromV7(stored, from, pct);
    assignments[name] = kept ?? roll(name, id) < pct;
  }
  return assignments;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
