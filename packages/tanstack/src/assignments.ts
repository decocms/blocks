/**
 * How the worker hands the app what it decided: each test of the saved
 * `experiments` block on or off for the request's visitor and each campaign
 * of the saved `campaigns` block running or not, as one request header. The
 * worker writes it (`./worker/index.ts`); the app reads it (`contentClient`
 * from `@decocms/tanstack/server`), so the page builds
 * `cms.client({ version, experiments, campaigns })` and decides nothing
 * again. Type imports only, no state: safe in every bundle.
 */
import type { Assignments } from "@decocms/blocks/experiments";

/**
 * The request header carrying the decided tests and campaigns
 * (`serializeAssignments`). The worker removes any copy that arrives from
 * outside, so a client can't send one itself.
 */
export const ASSIGNMENTS_HEADER = "x-deco-assignments";

/** The tests and campaigns of one request, every name on or off. */
export interface DecidedAssignments {
  /** Each test of the saved `experiments` block: on or off. */
  experiments: Readonly<Assignments>;
  /** Each campaign of the saved `campaigns` block: running or not. */
  campaigns: Readonly<Assignments>;
}

/** Plain code-unit order, the same on every server and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const record = (): Assignments => Object.create(null) as Assignments;

/** `+name` on, `-name` off, names URL-encoded and sorted. */
function encodeStates(states: Readonly<Assignments>): string {
  return Object.keys(states)
    .sort(byCodeUnit)
    .map((name) => `${states[name] === true ? "+" : "-"}${encodeURIComponent(name)}`)
    .join(",");
}

/**
 * The tests and campaigns as one header value, every name with its state:
 * `x=+on,-off|c=+running,-not` (names URL-encoded and sorted), `-` for none.
 */
export function serializeAssignments(assignments: DecidedAssignments): string {
  const parts: string[] = [];
  const tests = encodeStates(assignments.experiments);
  const campaigns = encodeStates(assignments.campaigns);
  if (tests) parts.push(`x=${tests}`);
  if (campaigns) parts.push(`c=${campaigns}`);
  return parts.length === 0 ? "-" : parts.join("|");
}

/** What `serializeAssignments` wrote; `null` for anything else (absent, malformed, spelled another way). */
export function parseAssignments(value: string | null | undefined): DecidedAssignments | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed: DecidedAssignments = { experiments: record(), campaigns: record() };
  if (value === "-") return parsed;
  const seen = new Set<string>();
  try {
    for (const part of value.split("|")) {
      const eq = part.indexOf("=");
      const tag = part.slice(0, eq);
      const list = part.slice(eq + 1);
      if (eq <= 0 || list === "" || seen.has(tag) || (tag !== "x" && tag !== "c")) return null;
      seen.add(tag);
      const target = (tag === "x" ? parsed.experiments : parsed.campaigns) as Assignments;
      for (const entry of list.split(",")) {
        const state = entry[0];
        if (state !== "+" && state !== "-") return null;
        target[decodeURIComponent(entry.slice(1))] = state === "+";
      }
    }
  } catch {
    return null;
  }
  return serializeAssignments(parsed) === value ? parsed : null;
}
