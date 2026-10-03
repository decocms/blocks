import type { BlockFunction } from "../types";
import { analytics, page, redirect, telemetry } from "./data";
import { lazy } from "./lazy";
import { always, date, never } from "./matchers";
import { multivariate } from "./multivariate";

/**
 * The built-in blocks every block map gets. `secret` joins them with the
 * secrets module; its name is already reserved below.
 */
export const builtIns: Readonly<Record<string, BlockFunction>> = Object.freeze({
  lazy,
  multivariate,
  always,
  never,
  date,
  page,
  redirect,
  telemetry,
  analytics,
});

/** Names no saved block can take (see /next/saved-blocks#names). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([...Object.keys(builtIns), "secret"]);
