/**
 * Campaign dates as content (see /next/built-in-blocks#calendar): the
 * built-in type `calendar`, which the saved block `campaigns` has, and the
 * built-in rule `campaign`.
 *
 * - `campaigns` maps each campaign's name to one window, `{ start?, end? }`,
 *   ISO date-times with an offset. Resolving it gives each name and whether
 *   the client's date is inside its window, never a date.
 * - `campaign { name }` is `true` when that answer is `true`. A rule always
 *   names a campaign: there are no inline `{ start, end }` dates, so
 *   `calendar` is the only place date logic lives.
 *
 * The date is the client's (`client.date`: `cms.client({ date })`, or when
 * the client was created), read through `currentClient()` before any
 * `await`. A campaign the client is given (`cms.client({ campaigns })`) is
 * on or off as given, whatever its window; a name the block doesn't have
 * stays out.
 */
import { campaignOverrides, currentClient } from "../current.ts";

/** The saved block every `campaign` rule reads, and its built-in type. */
export const CAMPAIGNS_BLOCK = "campaigns";
export const CALENDAR_TYPE = "calendar";

/** The built-in rule that reads a campaign. */
export const CAMPAIGN_RULE = "campaign";

/** What resolving `campaigns` gives: each campaign and whether it is running. */
type Campaigns = Record<string, boolean>;

/**
 * `calendar`: each campaign and whether the current client's date is inside
 * its window, or, for a campaign the client was given, what it was given.
 */
export const calendar = (windows: Record<string, unknown> = {}): Campaigns => {
  const client = currentClient();
  const given = campaignOverrides(client);
  const at = client.date.getTime();
  const out = Object.create(null) as Campaigns;
  for (const name of Object.keys(windows)) {
    out[name] =
      given !== undefined && Object.hasOwn(given, name)
        ? given[name] === true
        : inside(windows[name], at);
  }
  return out;
};

/**
 * Whether `at` (ms since the epoch) is inside `window`, `{ start?, end? }`:
 * from `start` (inclusive) until `end` (exclusive); an empty or absent bound
 * is open. A window that isn't an object, or a bound that isn't an ISO 8601
 * date-time with an offset, is outside, so a typo can't switch a campaign
 * on. See `campaignTime` for how a bound reads.
 */
function inside(window: unknown, at: number): boolean {
  if (typeof window !== "object" || window === null || Array.isArray(window)) return false;
  const { start, end } = window as Record<string, unknown>;
  const from = campaignTime(start);
  const until = campaignTime(end);
  if (from === null || until === null) return false;
  return (from === undefined || at >= from) && (until === undefined || at < until);
}

/** An ISO 8601 date-time with its offset (`Z` or `±hh:mm`). */
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A campaign bound's time in ms since the epoch: `undefined` when absent or
 * empty (open), `null` when it can't be one. A bound is an ISO 8601
 * date-time with an explicit offset (`Z` or `±hh:mm`), so it names the same
 * moment on every runtime. A date without a time, a date-time without an
 * offset (whose moment depends on where it is read), a day the calendar
 * doesn't have and anything else, such as `"Nov 27 2026"`, can't be one,
 * so that campaign never runs.
 */
export function campaignTime(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const match = ISO_RE.exec(value);
  if (match === null || !isCalendarDate(match[1] as string)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Whether `yyyy-mm-dd` is a day of the calendar (some runtimes roll February 30 into March, others refuse it). */
function isCalendarDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

/** Inputs of the built-in `campaign` rule. */
interface CampaignProps {
  /** A campaign in the saved block `campaigns`. */
  name?: string;
}

/**
 * `campaign`: `true` while the campaign `name` of the saved block
 * `campaigns` is running for the client. An unknown name, no `campaigns`
 * block, or a rule without a name give `false`. The block is resolved once
 * per client, however many rules ask.
 */
export const campaign = ({ name }: CampaignProps = {}): boolean | Promise<boolean> => {
  const client = currentClient();
  if (typeof name !== "string") return false;
  return client
    .resolve<Record<string, unknown>>(CAMPAIGNS_BLOCK)
    .then(([campaigns]) => isTrueAt(campaigns, name));
};

function isTrueAt(record: unknown, name: string): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    Object.hasOwn(record, name) &&
    (record as Record<string, unknown>)[name] === true
  );
}
