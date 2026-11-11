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
 * A visitor is only its id, stored as is in the `deco_vid` cookie and written
 * once, on a first visit. v7's `deco_segment` is neither read nor written:
 * its stored decisions aren't honoured, and a visitor who has only it gets a
 * new id.
 */

import { newId, roll } from "./bucketing.ts";

/** The saved block `experiments`: each test's name and the whole percentage of visitors in it, 0–100. */
export type Experiments = Record<string, number>;

/** What a visitor got: each test's name and whether they are in it. */
export type Assignments = Record<string, boolean>;

/** Who is visiting: an id every assignment is computed from, and nothing else. */
export interface Visitor {
  /** 16 random bytes as 22 base64url characters, drawn once per visitor. */
  id: string;
}

/** What `readVisitor` answers. */
export interface VisitorFromRequest {
  /** The request's visitor, or a new one when it had none. */
  visitor: Visitor;
  /**
   * The `Set-Cookie` line to send when the visitor had no id (a first
   * visit); `null` otherwise. Never send it from a preview.
   */
  cookie: string | null;
}

/** The fields of a request `readVisitor` reads: a `Request`, or anything with its `headers`. */
interface RequestWithHeaders {
  url?: string;
  headers: { get(name: string): string | null };
}

/** The visitor's cookie: the id, as is. */
const VISITOR_COOKIE = "deco_vid";

/** One year: the id is the visitor, and it should outlive any single test. */
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** The id in a stored value, or `undefined`. Tolerates surrounding spaces and percent-encoding. */
function idOf(text: string | null | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  let value = text.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return ID_RE.test(value) ? value : undefined;
}

/** A new visitor: a fresh id. */
export function newVisitor(): Visitor {
  return { id: newId() };
}

/**
 * A visitor out of its stored form (what `serializeVisitor` wrote: the value
 * of the `deco_vid` cookie or of `x-deco-visitor`). `null` when the text is
 * missing or isn't an id. Never throws.
 */
export function parseVisitor(text: string | null | undefined): Visitor | null {
  const id = idOf(text);
  return id === undefined ? null : { id };
}

/** The visitor's stored form: its id. */
export function serializeVisitor(visitor: Visitor): string {
  return visitor.id;
}

/** The raw `deco_vid` value out of a `Cookie` header. */
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
 * The web helper: the visitor out of a request's `deco_vid` cookie, and the
 * `Set-Cookie` line to send back when it had none (a first visit). The cookie
 * isn't `HttpOnly`, so a script on the page can read the id, and is `Secure`
 * unless the request came over plain http. Never throws.
 */
export function readVisitor(request: RequestWithHeaders): VisitorFromRequest {
  let header: string | null = null;
  try {
    header = request.headers.get("cookie");
  } catch {
    header = null;
  }
  const stored = parseVisitor(readCookie(header));
  if (stored !== null) return { visitor: stored, cookie: null };
  const visitor = newVisitor();
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
 * This visitor's answer for every test: `true` when they are in it.
 *
 * A visitor is in a test when their roll for it (a fixed number in [0, 100)
 * from the test's name and their id) is under its percentage, so 0 puts
 * nobody in, 100 everybody, and raising a percentage only adds people. A
 * fractional percentage is rounded. Without a visitor, or with an id that
 * isn't 22 base64url characters, every test is `false`. Entries that aren't
 * finite numbers are left out. Pure; never throws.
 */
export function assign(
  experiments: Experiments | null | undefined,
  visitor: Visitor | null | undefined,
): Assignments {
  const assignments = Object.create(null) as Assignments;
  if (typeof experiments !== "object" || experiments === null) return assignments;
  const id = visitor !== null && typeof visitor === "object" ? visitor.id : undefined;
  const known = typeof id === "string" && ID_RE.test(id);
  for (const name of Object.keys(experiments).sort()) {
    const allocation = experiments[name];
    if (typeof allocation !== "number" || !Number.isFinite(allocation)) continue;
    assignments[name] = known && roll(name, id as string) < roundPct(allocation);
  }
  return assignments;
}
