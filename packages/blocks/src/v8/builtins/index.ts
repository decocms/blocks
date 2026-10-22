import type { BlockFunction } from "../types.ts";
import { CALENDAR_TYPE, calendar, campaign } from "./campaigns.ts";
import { cmsSettings, page, redirect, SETTINGS_TYPE } from "./data.ts";
import { experiment, SPLIT_TRAFFIC_TYPE, splitTraffic } from "./experiments.ts";
import { lazy } from "./lazy.ts";
import { always, never } from "./matchers.ts";
import { multivariate } from "./multivariate.ts";
import { secretBlock } from "./secret.ts";

/**
 * The built-in blocks every block map gets. `secret` here has no key, so it
 * always fails; each CMS replaces it with one holding its `secrets.key`.
 */
export const builtIns: Readonly<Record<string, BlockFunction>> = Object.freeze({
  lazy,
  multivariate,
  always,
  never,
  experiment,
  campaign,
  page,
  redirect,
  [SETTINGS_TYPE]: cmsSettings,
  secret: secretBlock(),
  [SPLIT_TRAFFIC_TYPE]: splitTraffic,
  [CALENDAR_TYPE]: calendar,
});

/** Names no saved block can take (see /next/saved-blocks#names). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(Object.keys(builtIns));
