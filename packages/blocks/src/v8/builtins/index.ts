import type { BlockFunction } from "../types.ts";
import { analytics, page, redirect, telemetry } from "./data.ts";
import { lazy } from "./lazy.ts";
import { always, date, never } from "./matchers.ts";
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
  date,
  page,
  redirect,
  telemetry,
  analytics,
  secret: secretBlock(),
});

/** Names no saved block can take (see /next/saved-blocks#names). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(Object.keys(builtIns));
