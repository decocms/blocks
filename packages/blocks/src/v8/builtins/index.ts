import type { BlockFunction } from "../types.ts";
import { cmsSettings, page, redirect, SETTINGS_TYPE } from "./data.ts";
import { EXPERIMENTS_TYPE, experiment, experiments } from "./experiments.ts";
import { lazy } from "./lazy.ts";
import { always, date, never } from "./matchers.ts";
import { multivariate } from "./multivariate.ts";
import { SCHEDULES_TYPE, schedule, schedules } from "./schedules.ts";
import { secretBlock } from "./secret.ts";

/**
 * The built-in blocks every block map gets. `secret` here has no key, so it
 * always fails; each CMS replaces it with one holding its `secrets.key`.
 * `experiment` here has no assignments, so it is always `false`; each client
 * created with `{ assignments }` gets one holding them. `schedule` here has
 * no snapshot, so it is always `false`; each client binds it to the
 * `Schedules` block of the snapshot it reads.
 */
export const builtIns: Readonly<Record<string, BlockFunction>> = Object.freeze({
  lazy,
  multivariate,
  always,
  never,
  date,
  experiment,
  schedule,
  page,
  redirect,
  [SETTINGS_TYPE]: cmsSettings,
  [EXPERIMENTS_TYPE]: experiments,
  [SCHEDULES_TYPE]: schedules,
  secret: secretBlock(),
});

/** Names no saved block can take (see /next/saved-blocks#names). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(Object.keys(builtIns));
