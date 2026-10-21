/**
 * Campaign dates as content (see /next/built-in-blocks#date-windows): the
 * built-in type `date-windows`, which the saved block `campaigns` has, and
 * the built-in rule `date`.
 *
 * - `campaigns` maps each campaign's name to one window, `{ start?, end? }`,
 *   ISO date-times with an offset. Resolving it gives each name and whether
 *   the client's moment is inside its window, never a date.
 * - `date { campaign }` is `true` when that answer is `true`. Every date rule
 *   names a campaign: there are no inline `{ start, end }` dates, so
 *   `date-windows` is the only place date logic lives.
 *
 * The moment is the client's (`client.now`: a preview's time, or when the
 * client was created), read through `currentClient()` before any `await`.
 */
import { currentClient } from "../current.ts";

/** The saved block every `date` rule reads, and its built-in type. */
export const CAMPAIGNS_BLOCK = "campaigns";
export const DATE_WINDOWS_TYPE = "date-windows";

/** The built-in rule that reads a campaign. */
export const DATE_RULE = "date";

/** What resolving `campaigns` gives: each campaign and whether it is running now. */
type Campaigns = Record<string, boolean>;

/**
 * `date-windows`: each campaign and whether the current client's moment is
 * inside its window.
 */
export const dateWindows = (windows: Record<string, unknown> = {}): Campaigns => {
  const now = currentClient().now.getTime();
  const out = Object.create(null) as Campaigns;
  for (const name of Object.keys(windows)) out[name] = inside(windows[name], now);
  return out;
};

/**
 * Whether `at` (ms since the epoch) is inside `window`, `{ start?, end? }`:
 * from `start` (inclusive) until `end` (exclusive); an empty or absent bound
 * is open. A window that isn't an object, or a bound that isn't a string or
 * doesn't parse, is outside, so a typo can't switch a campaign on. A date without a time means midnight UTC.
 */
function inside(window: unknown, at: number): boolean {
  if (typeof window !== "object" || window === null || Array.isArray(window)) return false;
  const { start, end } = window as Record<string, unknown>;
  const from = bound(start);
  const until = bound(end);
  if (from === null || until === null) return false;
  return (from === undefined || at >= from) && (until === undefined || at < until);
}

/** A bound's time: `undefined` when absent or empty, `null` when it can't be one. */
function bound(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Inputs of the built-in `date` rule. */
interface DateProps {
  /** A campaign in the saved block `campaigns`. */
  campaign?: string;
}

/**
 * `date`: `true` while the campaign `campaign` of the saved block
 * `campaigns` is running at the client's moment. An unknown name, no
 * `campaigns` block, or a rule without a campaign (an inline `{ start, end }`
 * left from before, which `deco check` warns about) give `false`. The block
 * is resolved once per client, however many rules ask.
 */
export const date = ({ campaign }: DateProps = {}): boolean | Promise<boolean> => {
  const client = currentClient();
  if (typeof campaign !== "string") return false;
  return client
    .resolve<Record<string, unknown>>(CAMPAIGNS_BLOCK)
    .then(([campaigns]) => isTrueAt(campaigns, campaign));
};

function isTrueAt(record: unknown, name: string): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    Object.hasOwn(record, name) &&
    (record as Record<string, unknown>)[name] === true
  );
}
