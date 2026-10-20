/**
 * Campaign dates as content (see /next/built-in-blocks#schedules): the
 * built-in type `schedules`, saved once as the well-known block `Schedules`
 * (the site editor shows it as Campaigns), and the built-in matcher
 * `schedule`.
 *
 * - `Schedules` maps each campaign's name to one window, `{ start?, end? }`,
 *   ISO date-times with an offset, saved as plain values.
 * - `schedule` (`{ name }`) is the built-in `date` matcher over that window:
 *   `start` inclusive, `end` exclusive. An unknown name gives `false`.
 * - Each client binds `schedule` to the snapshot it reads, so a draft client
 *   reads the draft's `Schedules`: a campaign created in a draft runs in its
 *   preview. Inline `date` rules are unchanged.
 */
import { isPlainObject, own } from "../json.ts";
import type { BlockFunction, Blocks, Snapshot } from "../types.ts";
import { date } from "./matchers.ts";

/** The well-known saved block that holds the campaign dates, and its built-in type. */
export const SCHEDULES_BLOCK = "Schedules";
export const SCHEDULES_TYPE = "schedules";

/** The built-in matcher that reads a campaign's window. */
export const SCHEDULE_MATCHER = "schedule";

/** One campaign's window: ISO date-times with an offset, both optional. */
export interface ScheduleWindow {
  /** Inclusive. */
  start?: string;
  /** Exclusive: `end` itself doesn't match. */
  end?: string;
}

/** `schedules`: the type of the well-known saved block `Schedules`; returns its input. */
export const schedules = (
  props: Record<string, ScheduleWindow> = {},
): Record<string, ScheduleWindow> => props;

/** Inputs of the built-in `schedule` matcher. */
interface ScheduleProps {
  /** A name in the `Schedules` block. */
  name?: string;
}

/**
 * The `Schedules` block a snapshot holds: each name whose saved value is a
 * window, as saved. A missing block, or a block of another type, gives no
 * windows.
 */
export function readSchedules(snapshot: Snapshot): Record<string, ScheduleWindow> {
  const out = Object.create(null) as Record<string, ScheduleWindow>;
  const entry = own(snapshot.blocks, SCHEDULES_BLOCK);
  if (!isPlainObject(entry) || entry.__resolveType !== SCHEDULES_TYPE) return out;
  for (const name of Object.keys(entry)) {
    if (name === "__resolveType") continue;
    const window = entry[name];
    if (isPlainObject(window)) out[name] = window as ScheduleWindow;
  }
  return out;
}

/**
 * The `schedule` matcher of one snapshot: the built-in `date` matcher over
 * the window `name` has in its `Schedules` block. An unknown name gives
 * `false`, and so does a bound that isn't a string (never a campaign that
 * runs forever by mistake). The block is read once, on the first rule.
 */
export function scheduleMatcher(snapshot: Snapshot | undefined): BlockFunction {
  let windows: Record<string, ScheduleWindow> | undefined;
  return ({ name }: ScheduleProps = {}): boolean => {
    if (typeof name !== "string" || snapshot === undefined) return false;
    windows ??= readSchedules(snapshot);
    const window = own(windows, name);
    if (window === undefined) return false;
    const { start, end } = window as Record<string, unknown>;
    if (!isBound(start) || !isBound(end)) return false;
    return date({ start: start ?? undefined, end: end ?? undefined });
  };
}

/** `schedule` outside a client: there is no snapshot, so every rule is `false`. */
export const schedule = scheduleMatcher(undefined);

/**
 * The built-ins of a client reading `snapshot`: `schedule` bound to its
 * `Schedules` block. A built-ins table without `schedule` is returned as is.
 */
export function withSchedules(builtIns: Readonly<Blocks>, snapshot: Snapshot): Readonly<Blocks> {
  if (own(builtIns, SCHEDULE_MATCHER) === undefined) return builtIns;
  return Object.freeze({ ...builtIns, [SCHEDULE_MATCHER]: scheduleMatcher(snapshot) });
}

/** An absent bound (`undefined`, `null`, as a cleared field saves it) or a string. */
function isBound(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}
