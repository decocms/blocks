import type { FlagObj, Matcher } from "./types";
import Audience, { type Route, type Routes } from "./audience";

/**
 * Ported from apps-start's `website/matchers/always.ts`. That file existed
 * as its own block file only because deco-cx's old manifest system
 * discovered matchers by scanning files; this codebase's matcher/flag
 * mechanisms aren't file-scanned, so it's inlined here as its sole
 * consumer. (Its `cacheable = true` export was manifest-generation
 * metadata for that old system with no runtime consumer — dropped, same
 * as the rest of the `date`/matcher ports in `../matchers/builtins.ts`.)
 */
const MatchAlways: Matcher = () => true;

export interface EveryoneConfig {
  routes?: Routes;
}

/**
 * @title Audience Everyone
 * @description Always match regardless of the current user
 */
export default function Everyone({ routes }: EveryoneConfig): FlagObj<Route[]> {
  return Audience({
    matcher: MatchAlways,
    routes: routes ?? [],
    name: "Everyone",
  });
}
