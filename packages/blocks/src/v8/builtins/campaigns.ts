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
