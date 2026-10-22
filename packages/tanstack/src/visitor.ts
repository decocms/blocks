/**
 * How the worker hands the app the visitor: the request header it sets on a
 * page or server-function request once it read the visitor (`readVisitor`
 * from `@decocms/blocks/experiments`, a new one on a first visit). The worker
 * writes it (`./worker/index.ts`); the app reads it (`contentClient` from
 * `@decocms/tanstack/server`). No imports, no state: safe in every bundle.
 */

/**
 * The request header carrying the visitor, in its stored form (the
 * `deco_segment` cookie's value, `serializeVisitor`). The worker removes any
 * copy that arrives from outside, so a client can't send one itself.
 */
export const VISITOR_HEADER = "x-deco-visitor";
